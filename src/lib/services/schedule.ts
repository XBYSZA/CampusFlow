import type { Prisma } from "@/generated/prisma/client";
import { PRIORITIES, validateScheduleOwner } from "@/lib/domain";
import { prisma } from "@/lib/prisma";
import {
  PLAN_STRATEGY,
  planSchedule,
  type BusyInterval,
  type CourseConstraint,
  type DependencyReady,
} from "@/lib/planning/engine";
import {
  confirmPlanPayloadSchema,
  planMinutesFor,
  planPreviewSchema,
  type PlanBlock,
  type PlanPreview,
  type PlanningItem,
  type UnscheduledItem,
  type WeekCalendarEventBlock,
  type WeekConflictView,
  type WeekCourseBlock,
  type WeekDay,
  type WeekScheduleView,
} from "@/lib/planning/contract";
import {
  PLAN_GRID_MINUTES,
  PLAN_WINDOW_END_MINUTE,
  PLAN_WINDOW_START_MINUTE,
  addDays,
  addMinutes,
  dateKey,
  formatDate,
  formatDateTime,
  intervalsOverlap,
  minuteOfDay,
  weekdayOf,
  weekStartMonday,
} from "@/lib/time";

// ============================================================
// 日程服务（S4）
// 职责：
//   1) 读取 Task/SubTask/Dependency/Course/Schedule，构建排期输入
//   2) 调用确定性 PlanningEngine 生成预览（不写库）
//   3) 确认时重新查询数据库、逐条复核约束，再事务写入 Schedule + DecisionLog
// ============================================================

export class ScheduleError extends Error {
  constructor(
    public readonly code:
      | "VALIDATION_FAILED"
      | "OWNER_NOT_FOUND"
      | "OWNER_TYPE_MISMATCH"
      | "PARENT_WITH_SUBTASKS"
      | "ALREADY_SCHEDULED"
      | "BLOCK_INVALID"
      | "BLOCK_IN_PAST"
      | "BLOCK_OUT_OF_RANGE"
      | "DEADLINE_EXCEEDED"
      | "COURSE_OVERLAP"
      | "CALENDAR_EVENT_OVERLAP"
      | "SCHEDULE_OVERLAP"
      | "BLOCK_OVERLAP"
      | "DEPENDENCY_VIOLATION"
      | "DURATION_MISMATCH"
      | "PLAN_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ScheduleError";
  }
}

/** 有效日程：除已取消外的所有状态都视为占用（S4 不会自动删除或覆盖既有计划） */
const EFFECTIVE_SCHEDULE_WHERE = { status: { not: "CANCELLED" } } as const;

const MAX_RANGE_DAYS = 14;
const DEFAULT_RANGE_DAYS = 7;
const MAX_BLOCK_MINUTES = 120;

type ScheduleWithOwner = Prisma.ScheduleGetPayload<{
  include: {
    task: { select: { id: true; title: true } };
    subTask: { select: { id: true; title: true; taskId: true } };
  };
}>;

/** 构建 PlanningItem 所需的纯数据（便于 verify 直接构造，不依赖 Prisma） */
export interface PlanningSubTaskInput {
  id: string;
  title: string;
  estimatedMinutes: number | null;
  status: string;
  dependsOnIds: string[];
}

export interface PlanningTaskInput {
  id: string;
  title: string;
  deadline: Date | null;
  priority: string;
  status: string;
  estimatedMinutes: number | null;
  subTasks: PlanningSubTaskInput[];
}

export interface PlanningBuildResult {
  items: PlanningItem[];
  unscheduled: UnscheduledItem[];
}

export interface PlanningContext {
  tasks: PlanningTaskInput[];
  courses: CourseConstraint[];
  schedules: ScheduleWithOwner[];
  scheduledOwnerIds: Set<string>;
  busy: BusyInterval[];
  dependencyReadyAt: DependencyReady[];
  /** 不可移动的临时固定事件，与 Course / Schedule 同等优先级 */
  calendarEvents: Array<{ id: string; title: string; startAt: Date; endAt: Date; location: string | null }>;
}

function normalizePriority(value: string): "LOW" | "MEDIUM" | "HIGH" {
  return (PRIORITIES as readonly string[]).includes(value)
    ? (value as "LOW" | "MEDIUM" | "HIGH")
    : "MEDIUM";
}

function estimateProblem(
  estimatedMinutes: number | null,
): { reason: string } | null {
  if (estimatedMinutes === null || estimatedMinutes === undefined) {
    return { reason: "缺少预计耗时，无法自动排期" };
  }
  if (estimatedMinutes < 15) {
    return { reason: `预计耗时 ${estimatedMinutes} 分钟，低于最小排期粒度，无法自动排期` };
  }
  if (estimatedMinutes > 24 * 60) {
    return { reason: "预计耗时超过 24 小时，无法自动排期" };
  }
  return null;
}

/**
 * 情况 A：Task 没有 SubTask → 排 Task 本身。
 * 情况 B：Task 已有 SubTask → 只排 SubTask，父 Task 绝不重复排。
 * 另外：已完成的不排；已有有效日程的 owner 不重复排。
 */
export function buildPlanningItems(
  tasks: PlanningTaskInput[],
  scheduledOwnerIds: Set<string>,
): PlanningBuildResult {
  const items: PlanningItem[] = [];
  const unscheduled: UnscheduledItem[] = [];

  for (const task of tasks) {
    if (task.status === "DONE") continue;

    const deadline = task.deadline ? task.deadline.toISOString() : null;

    if (task.subTasks.length > 0) {
      // 情况 B：父任务本身不进入排期
      for (const subTask of task.subTasks) {
        if (subTask.status === "DONE") continue;
        if (scheduledOwnerIds.has(subTask.id)) continue;

        const problem = estimateProblem(subTask.estimatedMinutes);
        if (problem) {
          unscheduled.push({
            ownerType: "SUBTASK",
            ownerId: subTask.id,
            title: subTask.title,
            reason: problem.reason,
          });
          continue;
        }

        items.push({
          ownerType: "SUBTASK",
          ownerId: subTask.id,
          taskId: task.id,
          title: subTask.title,
          estimatedMinutes: subTask.estimatedMinutes as number,
          deadline,
          dependsOnOwnerIds: [...subTask.dependsOnIds],
          priority: normalizePriority(task.priority),
        });
      }
      continue;
    }

    // 情况 A：无子任务的任务直接作为排期对象
    if (scheduledOwnerIds.has(task.id)) continue;

    const problem = estimateProblem(task.estimatedMinutes);
    if (problem) {
      unscheduled.push({
        ownerType: "TASK",
        ownerId: task.id,
        title: task.title,
        reason: problem.reason,
      });
      continue;
    }

    items.push({
      ownerType: "TASK",
      ownerId: task.id,
      taskId: task.id,
      title: task.title,
      estimatedMinutes: task.estimatedMinutes as number,
      deadline,
      dependsOnOwnerIds: [],
      priority: normalizePriority(task.priority),
    });
  }

  return { items, unscheduled };
}

/** 读取并规范化排期所需数据（预览与确认都从数据库重新读取） */
export async function loadPlanningContext(): Promise<PlanningContext> {
  const [tasks, courses, schedules, calendarEvents] = await Promise.all([
    prisma.task.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        subTasks: {
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          include: { dependencies: { select: { dependsOnId: true } } },
        },
      },
    }),
    prisma.course.findMany({ orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }] }),
    prisma.schedule.findMany({
      where: EFFECTIVE_SCHEDULE_WHERE,
      orderBy: { startAt: "asc" },
      include: {
        task: { select: { id: true, title: true } },
        subTask: { select: { id: true, title: true, taskId: true } },
      },
    }),
    prisma.calendarEvent.findMany({ orderBy: { startAt: "asc" } }),
  ]);

  const scheduledOwnerIds = new Set<string>();
  const busy: BusyInterval[] = [];
  const dependencyReadyAt: DependencyReady[] = [];

  for (const schedule of schedules) {
    const ownerId = schedule.subTaskId ?? schedule.taskId;
    if (!ownerId) continue;
    scheduledOwnerIds.add(ownerId);
    busy.push({
      startAt: schedule.startAt,
      endAt: schedule.endAt,
      label: schedule.subTask?.title ?? schedule.task?.title ?? "已有日程",
    });
    dependencyReadyAt.push({
      ownerId,
      readyAt: schedule.endAt,
      title: schedule.subTask?.title ?? schedule.task?.title,
    });
  }

  // CalendarEvent 同样作为固定占用，进入排期引擎的 busy
  for (const event of calendarEvents) {
    busy.push({
      startAt: event.startAt,
      endAt: event.endAt,
      label: event.title,
    });
  }

  return {
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      deadline: task.deadline,
      priority: task.priority,
      status: task.status,
      estimatedMinutes: task.estimatedMinutes,
      subTasks: task.subTasks.map((subTask) => ({
        id: subTask.id,
        title: subTask.title,
        estimatedMinutes: subTask.estimatedMinutes,
        status: subTask.status,
        dependsOnIds: subTask.dependencies.map((dep) => dep.dependsOnId),
      })),
    })),
    courses: courses.map((course) => ({
      id: course.id,
      title: course.title,
      dayOfWeek: course.dayOfWeek,
      startMinute: course.startMinute,
      endMinute: course.endMinute,
      location: course.location,
    })),
    schedules,
    scheduledOwnerIds,
    busy,
    dependencyReadyAt,
    calendarEvents: calendarEvents.map((event) => ({
      id: event.id,
      title: event.title,
      startAt: event.startAt,
      endAt: event.endAt,
      location: event.location,
    })),
  };
}

export interface PreviewInput {
  rangeStart?: string | null;
  rangeDays?: number | null;
}

/**
 * 生成排期预览：只读数据库，不写 Schedule。
 * 同一输入 + 同一 now → 同一结果（由 PlanningEngine 保证确定性）。
 */
export async function generatePlanPreview(
  input: PreviewInput = {},
  now: Date = new Date(),
): Promise<PlanPreview> {
  const rawDays = input.rangeDays ?? DEFAULT_RANGE_DAYS;
  if (!Number.isInteger(rawDays) || rawDays < 1 || rawDays > MAX_RANGE_DAYS) {
    throw new ScheduleError(
      "VALIDATION_FAILED",
      `rangeDays 必须是 1~${MAX_RANGE_DAYS} 的整数`,
    );
  }

  let rangeStart: Date;
  if (input.rangeStart) {
    rangeStart = new Date(input.rangeStart);
    if (Number.isNaN(rangeStart.getTime())) {
      throw new ScheduleError("VALIDATION_FAILED", `rangeStart 不是合法时间：${input.rangeStart}`);
    }
  } else {
    rangeStart = weekStartMonday(now);
  }
  const rangeEnd = addDays(rangeStart, rawDays);

  const context = await loadPlanningContext();
  const build = buildPlanningItems(context.tasks, context.scheduledOwnerIds);

  const output = planSchedule({
    items: build.items,
    courses: context.courses,
    busy: context.busy,
    dependencyReadyAt: context.dependencyReadyAt,
    rangeStart,
    rangeEnd,
    now,
  });

  const preview = {
    generatedAt: now.toISOString(),
    rangeStart: rangeStart.toISOString(),
    rangeEnd: rangeEnd.toISOString(),
    strategy: PLAN_STRATEGY,
    blocks: output.blocks,
    unscheduled: [...build.unscheduled, ...output.unscheduled],
  };

  const parsed = planPreviewSchema.safeParse(preview);
  if (!parsed.success) {
    throw new ScheduleError(
      "PLAN_INVALID",
      `排期结果未通过契约校验：${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("；")}`,
    );
  }

  return parsed.data;
}

export interface WeekScheduleResult extends WeekScheduleView {
  /** 当前时间（上海语义），便于页面提示 */
  now: string;
}

/** 周视图数据：7 天课程 + 周内有效日程 + 待安排数量 + 临时事件 + 冲突 */
export async function getWeekSchedule(now: Date = new Date()): Promise<WeekScheduleResult> {
  const weekStart = weekStartMonday(now);
  const weekEnd = addDays(weekStart, 7);
  const context = await loadPlanningContext();
  const build = buildPlanningItems(context.tasks, context.scheduledOwnerIds);

  const [calendarEvents, conflicts] = await Promise.all([
    prisma.calendarEvent.findMany({
      where: { endAt: { gt: weekStart }, startAt: { lt: weekEnd } },
      orderBy: { startAt: "asc" },
    }),
    prisma.conflict.findMany({
      include: {
        scheduleA: {
          select: {
            id: true,
            taskId: true,
            subTaskId: true,
            startAt: true,
            endAt: true,
            task: { select: { title: true } },
            subTask: { select: { title: true } },
          },
        },
        course: { select: { title: true } },
        calendarEvent: { select: { title: true, startAt: true, endAt: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const allCalendarEvents: WeekCalendarEventBlock[] = calendarEvents.map((event) => ({
    id: event.id,
    title: event.title,
    location: event.location,
    eventType: event.eventType,
    startAt: event.startAt.toISOString(),
    endAt: event.endAt.toISOString(),
  }));

  const days: WeekDay[] = [];
  for (let index = 0; index < 7; index += 1) {
    const dayStart = addDays(weekStart, index);
    const dayEnd = addDays(dayStart, 1);
    const weekday = weekdayOf(dayStart);

    const courses: WeekCourseBlock[] = context.courses
      .filter((course) => course.dayOfWeek === weekday)
      .map((course) => ({
        id: course.id,
        title: course.title,
        location: course.location ?? null,
        startMinute: course.startMinute,
        endMinute: course.endMinute,
        startAt: addMinutes(dayStart, course.startMinute).toISOString(),
        endAt: addMinutes(dayStart, course.endMinute).toISOString(),
      }));

    const schedules = context.schedules
      .filter(
        (schedule) =>
          schedule.startAt.getTime() < dayEnd.getTime() &&
          schedule.endAt.getTime() > dayStart.getTime(),
      )
      .map((schedule) => ({
        id: schedule.id,
        ownerType: (schedule.subTaskId ? "SUBTASK" : "TASK") as "TASK" | "SUBTASK",
        ownerId: (schedule.subTaskId ?? schedule.taskId ?? "") as string,
        taskId: (schedule.taskId ?? schedule.subTask?.taskId ?? null) as string | null,
        title: schedule.subTask?.title ?? schedule.task?.title ?? "未命名日程",
        startAt: schedule.startAt.toISOString(),
        endAt: schedule.endAt.toISOString(),
        status: schedule.status,
        rationale: schedule.rationale,
      }));

    const dayCalendarEvents = calendarEvents
      .filter(
        (event) =>
          event.startAt.getTime() < dayEnd.getTime() &&
          event.endAt.getTime() > dayStart.getTime(),
      )
      .map((event) => ({
        id: event.id,
        title: event.title,
        location: event.location,
        eventType: event.eventType,
        startAt: event.startAt.toISOString(),
        endAt: event.endAt.toISOString(),
      }));

    days.push({ dateKey: dateKey(dayStart), weekday, courses, schedules, calendarEvents: dayCalendarEvents });
  }

  const conflictViews: WeekConflictView[] = conflicts.map((c) => ({
    id: c.id,
    scheduleId: c.scheduleA.id,
    scheduleOwnerId: c.scheduleA.subTaskId ?? c.scheduleA.taskId ?? "",
    scheduleTitle: c.scheduleA.subTask?.title ?? c.scheduleA.task?.title ?? "未命名日程",
    scheduleStartAt: c.scheduleA.startAt.toISOString(),
    scheduleEndAt: c.scheduleA.endAt.toISOString(),
    courseTitle: c.course?.title ?? null,
    calendarEventTitle: c.calendarEvent?.title ?? null,
    calendarEventStartAt: c.calendarEvent?.startAt?.toISOString() ?? null,
    calendarEventEndAt: c.calendarEvent?.endAt?.toISOString() ?? null,
    conflictType: c.conflictType,
    description: c.description,
    resolved: c.resolvedAt !== null,
  }));

  return {
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    days,
    pendingCount: build.items.length,
    now: now.toISOString(),
    calendarEvents: allCalendarEvents,
    conflicts: conflictViews,
  };
}

// ------------------------------------------------------------
// 确认计划
// ------------------------------------------------------------

interface OwnerMeta {
  ownerType: "TASK" | "SUBTASK";
  ownerId: string;
  taskId: string;
  title: string;
  estimatedMinutes: number | null;
  deadline: Date | null;
  status: string;
  /** 该对象是否已有有效日程 */
  scheduled: boolean;
  /** 仅 TASK：是否已有子任务（有子任务时父任务不可直接排） */
  hasSubTasks: boolean;
  /** 仅 SUBTASK：依赖的前置子任务 ID */
  dependsOnIds: string[];
}

function buildOwnerIndex(context: PlanningContext): Map<string, OwnerMeta> {
  const index = new Map<string, OwnerMeta>();
  for (const task of context.tasks) {
    index.set(task.id, {
      ownerType: "TASK",
      ownerId: task.id,
      taskId: task.id,
      title: task.title,
      estimatedMinutes: task.estimatedMinutes,
      deadline: task.deadline,
      status: task.status,
      scheduled: context.scheduledOwnerIds.has(task.id),
      hasSubTasks: task.subTasks.length > 0,
      dependsOnIds: [],
    });
    for (const subTask of task.subTasks) {
      index.set(subTask.id, {
        ownerType: "SUBTASK",
        ownerId: subTask.id,
        taskId: task.id,
        title: subTask.title,
        estimatedMinutes: subTask.estimatedMinutes,
        deadline: task.deadline,
        status: subTask.status,
        scheduled: context.scheduledOwnerIds.has(subTask.id),
        hasSubTasks: false,
        dependsOnIds: subTask.dependsOnIds,
      });
    }
  }
  return index;
}

function toMs(value: string): number {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) {
    throw new ScheduleError("BLOCK_INVALID", `时间不是合法 ISO datetime：${value}`);
  }
  return time;
}

interface ValidatedBlock {
  block: PlanBlock;
  owner: OwnerMeta;
  startAt: Date;
  endAt: Date;
  duration: number;
}

/** 逐条复核单个计划块（owner 合法、时间合法、不越界、不与固定占用重叠） */
function validateBlock(
  block: PlanBlock,
  ownerIndex: Map<string, OwnerMeta>,
  context: PlanningContext,
  rangeStart: Date,
  rangeEnd: Date,
  now: Date,
): ValidatedBlock {
  const owner = ownerIndex.get(block.ownerId);
  if (!owner) {
    throw new ScheduleError("OWNER_NOT_FOUND", `计划块引用的对象不存在：${block.ownerId}`);
  }
  if (owner.ownerType !== block.ownerType) {
    throw new ScheduleError(
      "OWNER_TYPE_MISMATCH",
      `「${owner.title}」的类型是 ${owner.ownerType}，与提交的 ${block.ownerType} 不一致`,
    );
  }
  if (owner.ownerType === "TASK" && owner.hasSubTasks) {
    throw new ScheduleError(
      "PARENT_WITH_SUBTASKS",
      `任务「${owner.title}」已有子任务，只能安排子任务，不能直接安排父任务`,
    );
  }
  if (owner.status === "DONE") {
    throw new ScheduleError("BLOCK_INVALID", `「${owner.title}」已完成，不应再排期`);
  }
  if (owner.scheduled) {
    throw new ScheduleError(
      "ALREADY_SCHEDULED",
      `「${owner.title}」已有正式日程，拒绝重复确认`,
    );
  }

  const startMs = toMs(block.startAt);
  const endMs = toMs(block.endAt);
  if (startMs >= endMs) {
    throw new ScheduleError("BLOCK_INVALID", `「${owner.title}」的计划块 startAt 必须早于 endAt`);
  }

  const startAt = new Date(startMs);
  const endAt = new Date(endMs);
  const duration = (endMs - startMs) / (60 * 1000);

  if (!Number.isInteger(duration) || duration < 30 || duration > MAX_BLOCK_MINUTES) {
    throw new ScheduleError(
      "BLOCK_INVALID",
      `「${owner.title}」单块时长 ${duration} 分钟，必须是 30~${MAX_BLOCK_MINUTES} 分钟内 30 的倍数`,
    );
  }
  if (duration % PLAN_GRID_MINUTES !== 0) {
    throw new ScheduleError(
      "BLOCK_INVALID",
      `「${owner.title}」单块时长 ${duration} 分钟，不符合 30 分钟粒度`,
    );
  }

  const startMinute = minuteOfDay(startAt);
  const endMinute = minuteOfDay(endAt);
  if (
    dateKey(startAt) !== dateKey(endAt) ||
    startMinute % PLAN_GRID_MINUTES !== 0 ||
    startMinute < PLAN_WINDOW_START_MINUTE ||
    endMinute > PLAN_WINDOW_END_MINUTE
  ) {
    throw new ScheduleError(
      "BLOCK_INVALID",
      `「${owner.title}」的时段 ${formatDateTime(startAt)}-${formatDateTime(endAt)} 不在可安排区间 08:00-22:00 的 30 分钟网格上`,
    );
  }

  if (startMs < now.getTime()) {
    throw new ScheduleError(
      "BLOCK_IN_PAST",
      `「${owner.title}」的计划开始时间 ${formatDateTime(startAt)} 已经过去`,
    );
  }

  if (startMs < rangeStart.getTime() || endMs > rangeEnd.getTime()) {
    throw new ScheduleError(
      "BLOCK_OUT_OF_RANGE",
      `「${owner.title}」的计划块超出本次范围 ${formatDate(rangeStart)}-${formatDate(addDays(rangeEnd, -1))}`,
    );
  }

  if (owner.deadline && endMs > owner.deadline.getTime()) {
    throw new ScheduleError(
      "DEADLINE_EXCEEDED",
      `「${owner.title}」的计划结束时间 ${formatDateTime(endAt)} 超过截止时间 ${formatDateTime(owner.deadline)}`,
    );
  }

  const weekday = weekdayOf(startAt);
  for (const course of context.courses) {
    if (
      course.dayOfWeek === weekday &&
      intervalsOverlap(startMinute, endMinute, course.startMinute, course.endMinute)
    ) {
      throw new ScheduleError(
        "COURSE_OVERLAP",
        `「${owner.title}」的 ${formatDateTime(startAt)}-${formatDateTime(endAt)} 与课程「${course.title}」重叠`,
      );
    }
  }

  // CalendarEvent 与 Course 一样是不可移动的硬约束
  for (const event of context.calendarEvents) {
    if (
      intervalsOverlap(
        startMs,
        endMs,
        event.startAt.getTime(),
        event.endAt.getTime(),
      )
    ) {
      throw new ScheduleError(
        "CALENDAR_EVENT_OVERLAP",
        `「${owner.title}」的 ${formatDateTime(startAt)}-${formatDateTime(endAt)} 与固定事件「${event.title}」${formatDateTime(event.startAt)}-${formatDateTime(event.endAt)} 重叠`,
      );
    }
  }

  for (const schedule of context.schedules) {
    if (
      intervalsOverlap(
        startMs,
        endMs,
        schedule.startAt.getTime(),
        schedule.endAt.getTime(),
      )
    ) {
      throw new ScheduleError(
        "SCHEDULE_OVERLAP",
        `「${owner.title}」的计划块与已有日程「${schedule.subTask?.title ?? schedule.task?.title ?? schedule.id}」重叠`,
      );
    }
  }

  return { block, owner, startAt, endAt, duration };
}

function assertDependencies(
  validated: ValidatedBlock[],
  ownerIndex: Map<string, OwnerMeta>,
  context: PlanningContext,
): void {
  // 本次提交中每个 owner 的最后一个块结束时间
  const plannedFinish = new Map<string, number>();
  const plannedBlocks = new Map<string, ValidatedBlock[]>();
  for (const entry of validated) {
    const list = plannedBlocks.get(entry.owner.ownerId) ?? [];
    list.push(entry);
    plannedBlocks.set(entry.owner.ownerId, list);
    const current = plannedFinish.get(entry.owner.ownerId) ?? 0;
    plannedFinish.set(entry.owner.ownerId, Math.max(current, entry.endAt.getTime()));
  }

  // 已有有效日程的 owner 完成时间
  const scheduledFinish = new Map<string, number>();
  for (const schedule of context.schedules) {
    const ownerId = schedule.subTaskId ?? schedule.taskId;
    if (!ownerId) continue;
    const current = scheduledFinish.get(ownerId) ?? 0;
    scheduledFinish.set(ownerId, Math.max(current, schedule.endAt.getTime()));
  }

  for (const entry of validated) {
    const { owner } = entry;
    if (owner.dependsOnIds.length === 0) continue;

    let readyAt = 0;
    const blockers: string[] = [];
    for (const depId of owner.dependsOnIds) {
      const dep = ownerIndex.get(depId);
      if (!dep) {
        throw new ScheduleError(
          "DEPENDENCY_VIOLATION",
          `「${owner.title}」依赖的前置对象不存在：${depId}`,
        );
      }
      if (dep.status === "DONE") continue;
      const fromSchedule = scheduledFinish.get(depId);
      const fromPlan = plannedFinish.get(depId);
      const finish = Math.max(fromSchedule ?? 0, fromPlan ?? 0);
      if (finish <= 0) {
        blockers.push(dep.title);
        continue;
      }
      readyAt = Math.max(readyAt, finish);
    }

    if (blockers.length > 0) {
      throw new ScheduleError(
        "DEPENDENCY_VIOLATION",
        `「${owner.title}」的前置任务尚未完成且未安排：${blockers.join("、")}`,
      );
    }
    if (entry.startAt.getTime() < readyAt) {
      throw new ScheduleError(
        "DEPENDENCY_VIOLATION",
        `「${owner.title}」的计划开始时间 ${formatDateTime(entry.startAt)} 早于前置任务完成时间 ${formatDateTime(new Date(readyAt))}`,
      );
    }
  }
}

function assertNoInternalOverlap(validated: ValidatedBlock[]): void {
  for (let i = 0; i < validated.length; i += 1) {
    for (let j = i + 1; j < validated.length; j += 1) {
      const a = validated[i];
      const b = validated[j];
      if (
        intervalsOverlap(
          a.startAt.getTime(),
          a.endAt.getTime(),
          b.startAt.getTime(),
          b.endAt.getTime(),
        )
      ) {
        throw new ScheduleError(
          "BLOCK_OVERLAP",
          `计划块之间互相重叠：「${a.owner.title}」${formatDateTime(a.startAt)} 与「${b.owner.title}」${formatDateTime(b.startAt)}`,
        );
      }
    }
  }
}

function assertTotalDurations(validated: ValidatedBlock[]): void {
  const totals = new Map<string, { minutes: number; owner: OwnerMeta }>();
  for (const entry of validated) {
    const current = totals.get(entry.owner.ownerId) ?? { minutes: 0, owner: entry.owner };
    current.minutes += entry.duration;
    totals.set(entry.owner.ownerId, current);
  }

  for (const { minutes, owner } of totals.values()) {
    if (owner.estimatedMinutes === null) {
      throw new ScheduleError(
        "DURATION_MISMATCH",
        `「${owner.title}」缺少预计耗时，无法核对总时长`,
      );
    }
    const expected = planMinutesFor(owner.estimatedMinutes);
    if (minutes !== expected) {
      throw new ScheduleError(
        "DURATION_MISMATCH",
        `「${owner.title}」计划总时长 ${minutes} 分钟，与预计 ${owner.estimatedMinutes} 分钟（按 30 分钟粒度取整为 ${expected} 分钟）不一致`,
      );
    }
  }
}

export interface WritePlanParams {
  blocks: Array<{
    ownerType: "TASK" | "SUBTASK";
    ownerId: string;
    taskId: string;
    title: string;
    startAt: string;
    endAt: string;
    rationale: string;
  }>;
  rangeStart: Date;
  rangeEnd: Date;
  unscheduledByTask: Map<string, UnscheduledItem[]>;
  strategy: string;
}

export interface WritePlanResult {
  scheduleIds: string[];
  decisionLogIds: string[];
}

/**
 * 在给定事务中写入 Schedule 与 DecisionLog。
 * 单独导出，便于验证脚本注入失败、确认整体回滚。
 */
export async function writePlan(
  tx: Prisma.TransactionClient,
  params: WritePlanParams,
): Promise<WritePlanResult> {
  const ownerIds = [...new Set(params.blocks.map((block) => block.ownerId))];

  // 事务内再次确认 owner 未被安排：防并发与快速重复点击
  const existing = await tx.schedule.findMany({
    where: {
      status: { not: "CANCELLED" },
      OR: [
        { taskId: { in: ownerIds } },
        { subTaskId: { in: ownerIds } },
      ],
    },
    select: { taskId: true, subTaskId: true },
  });
  if (existing.length > 0) {
    throw new ScheduleError(
      "ALREADY_SCHEDULED",
      "部分对象已存在正式日程，拒绝重复确认",
    );
  }

  const scheduleIds: string[] = [];
  for (const block of params.blocks) {
    const ownerError = validateScheduleOwner({
      taskId: block.ownerType === "TASK" ? block.ownerId : null,
      subTaskId: block.ownerType === "SUBTASK" ? block.ownerId : null,
    });
    if (ownerError) {
      throw new ScheduleError("BLOCK_INVALID", ownerError);
    }

    const created = await tx.schedule.create({
      data: {
        taskId: block.ownerType === "TASK" ? block.ownerId : null,
        subTaskId: block.ownerType === "SUBTASK" ? block.ownerId : null,
        startAt: new Date(block.startAt),
        endAt: new Date(block.endAt),
        status: "CONFIRMED",
        rationale: block.rationale,
      },
    });
    scheduleIds.push(created.id);
  }

  // 每个任务一条 PLAN 决策日志（relatedTaskId 关联到任务）
  const byTask = new Map<string, typeof params.blocks>();
  for (const block of params.blocks) {
    const list = byTask.get(block.taskId) ?? [];
    list.push(block);
    byTask.set(block.taskId, list);
  }

  const decisionLogIds: string[] = [];
  for (const [taskId, blocks] of byTask) {
    const sorted = [...blocks].sort(
      (a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
    );
    const unscheduled = params.unscheduledByTask.get(taskId) ?? [];

    const outputSummary = sorted
      .map(
        (block) =>
          `${block.title}：${formatDateTime(new Date(block.startAt))}-${formatDateTime(new Date(block.endAt))}`,
      )
      .join("；");

    const log = await tx.decisionLog.create({
      data: {
        actionType: "PLAN",
        inputSummary: `排期范围 ${formatDate(params.rangeStart)} 至 ${formatDate(addDays(params.rangeEnd, -1))}；本次确认 ${sorted.length} 个计划块，涉及 ${new Set(sorted.map((b) => b.ownerId)).size} 个对象`,
        outputSummary: unscheduled.length > 0
          ? `${outputSummary}；未安排 ${unscheduled.length} 项：${unscheduled.map((item) => `${item.title}（${item.reason}）`).join("、")}`
          : outputSummary,
        evidence: JSON.stringify({
          strategy: params.strategy,
          rangeStart: params.rangeStart.toISOString(),
          rangeEnd: params.rangeEnd.toISOString(),
          blocks: sorted.map((block) => ({
            ownerType: block.ownerType,
            ownerId: block.ownerId,
            title: block.title,
            startAt: block.startAt,
            endAt: block.endAt,
            rationale: block.rationale,
          })),
          unscheduled: unscheduled.map((item) => ({
            ownerType: item.ownerType,
            ownerId: item.ownerId,
            title: item.title,
            reason: item.reason,
          })),
        }),
        relatedTaskId: taskId,
      },
    });
    decisionLogIds.push(log.id);
  }

  return { scheduleIds, decisionLogIds };
}

export interface ConfirmPlanOutput {
  scheduleCount: number;
  blockCount: number;
  ownerCount: number;
  decisionLogIds: string[];
}

/**
 * 确认计划：重新查询数据库 → 逐条复核 13 类约束 → 事务写入。
 * 前端提交的块永远不被信任，标题、时长与截止时间都取自数据库。
 */
export async function confirmPlan(
  payload: unknown,
  now: Date = new Date(),
): Promise<ConfirmPlanOutput> {
  const parsed = confirmPlanPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ScheduleError(
      "VALIDATION_FAILED",
      `提交数据未通过校验：${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("；")}`,
    );
  }
  const data = parsed.data;
  const rangeStart = new Date(data.rangeStart);
  const rangeEnd = new Date(data.rangeEnd);
  if (rangeStart.getTime() >= rangeEnd.getTime()) {
    throw new ScheduleError("VALIDATION_FAILED", "rangeStart 必须早于 rangeEnd");
  }

  const context = await loadPlanningContext();
  const ownerIndex = buildOwnerIndex(context);

  const validated = data.blocks.map((block) =>
    validateBlock(block, ownerIndex, context, rangeStart, rangeEnd, now),
  );
  assertNoInternalOverlap(validated);
  assertTotalDurations(validated);
  assertDependencies(validated, ownerIndex, context);

  const unscheduledByTask = new Map<string, UnscheduledItem[]>();
  for (const item of data.unscheduled) {
    const owner = ownerIndex.get(item.ownerId);
    if (!owner) continue;
    const list = unscheduledByTask.get(owner.taskId) ?? [];
    list.push(item);
    unscheduledByTask.set(owner.taskId, list);
  }

  const writable = validated.map((entry) => ({
    ownerType: entry.owner.ownerType,
    ownerId: entry.owner.ownerId,
    taskId: entry.owner.taskId,
    title: entry.owner.title,
    startAt: entry.startAt.toISOString(),
    endAt: entry.endAt.toISOString(),
    // rationale 来自规则引擎预览，作为可解释依据原样保留
    rationale: entry.block.rationale,
  }));

  const written = await prisma.$transaction(async (tx) =>
    writePlan(tx, {
      blocks: writable,
      rangeStart,
      rangeEnd,
      unscheduledByTask,
      strategy: PLAN_STRATEGY,
    }),
  );

  return {
    scheduleCount: written.scheduleIds.length,
    blockCount: validated.length,
    ownerCount: new Set(validated.map((entry) => entry.owner.ownerId)).size,
    decisionLogIds: written.decisionLogIds,
  };
}
