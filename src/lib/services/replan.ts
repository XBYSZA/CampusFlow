import type { Prisma } from "@/generated/prisma/client";
import { PRIORITIES } from "@/lib/domain";
import { prisma } from "@/lib/prisma";
import {
  planSchedule,
  type BusyInterval,
  type DependencyReady,
} from "@/lib/planning/engine";
import {
  planMinutesFor,
  type PlanBlock,
  type PlanningItem,
  type UnscheduledItem,
} from "@/lib/planning/contract";
import {
  loadPlanningContext,
  type PlanningContext,
} from "@/lib/services/schedule";
import {
  PLAN_GRID_MINUTES,
  PLAN_WINDOW_END_MINUTE,
  PLAN_WINDOW_START_MINUTE,
  addDays,
  dateKey,
  formatTime,
  intervalsOverlap,
  minuteOfDay,
  weekdayOf,
} from "@/lib/time";

// ============================================================
// 重排服务（S5）
// 原则：只移动受冲突影响的 owner 及其下游依赖 owner，
//       未受影响 Schedule 作为固定占用保留，旧 Schedule 仅标记 CANCELLED。
// 时间决策复用 S4 PlanningEngine，不调用 LLM。
// ============================================================

export class ReplanError extends Error {
  constructor(
    public readonly code:
      | "VALIDATION_FAILED"
      | "NO_UNRESOLVED_CONFLICTS"
      | "CONFLICT_ALREADY_RESOLVED"
      | "OWNER_NOT_FOUND"
      | "OLD_SCHEDULE_GONE"
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
    this.name = "ReplanError";
  }
}

const MAX_RANGE_DAYS = 14;

interface OwnerMeta {
  ownerType: "TASK" | "SUBTASK";
  ownerId: string;
  taskId: string;
  title: string;
  estimatedMinutes: number | null;
  deadline: Date | null;
  status: string;
  dependsOnIds: string[];
  priority: string;
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
      dependsOnIds: [],
      priority: task.priority,
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
        dependsOnIds: subTask.dependsOnIds,
        priority: task.priority,
      });
    }
  }
  return index;
}

/** 从 conflict 的 scheduleA 反查 ownerId */
function scheduleOwnerId(schedule: {
  taskId: string | null;
  subTaskId: string | null;
}): string {
  return schedule.subTaskId ?? schedule.taskId ?? "";
}

/**
 * 计算受影响 owner 集合：
 *   直接冲突 owner ∪ 其下游依赖 owner（传递闭包）。
 * 依赖方向：subTaskId dependsOn dependsOnId → dependsOnId 是前置，subTaskId 是下游。
 */
export function computeAffectedOwners(params: {
  directOwnerIds: string[];
  dependencies: Array<{ subTaskId: string; dependsOnId: string }>;
}): Set<string> {
  const downstream = new Map<string, string[]>();
  for (const edge of params.dependencies) {
    const list = downstream.get(edge.dependsOnId) ?? [];
    list.push(edge.subTaskId);
    downstream.set(edge.dependsOnId, list);
  }

  const affected = new Set<string>(params.directOwnerIds);
  const queue = [...params.directOwnerIds];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const dependent of downstream.get(current) ?? []) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return affected;
}

interface ConflictWithSchedule {
  id: string;
  scheduleAId: string;
  scheduleA: { id: string; taskId: string | null; subTaskId: string | null; startAt: Date; endAt: Date };
  courseId: string | null;
  calendarEventId: string | null;
  description: string;
}

async function loadReplanContext(
  now: Date,
  conflictIds?: string[],
): Promise<{
  context: PlanningContext;
  ownerIndex: Map<string, OwnerMeta>;
  conflicts: ConflictWithSchedule[];
  calendarEvents: Array<{ id: string; title: string; startAt: Date; endAt: Date; location: string | null }>;
}> {
  const context = await loadPlanningContext();
  const conflictWhere: { resolvedAt: null; id?: { in: string[] } } = { resolvedAt: null };
  if (conflictIds && conflictIds.length > 0) {
    conflictWhere.id = { in: conflictIds };
  }
  const [conflicts, calendarEvents] = await Promise.all([
    prisma.conflict.findMany({
      where: conflictWhere,
      include: {
        scheduleA: { select: { id: true, taskId: true, subTaskId: true, startAt: true, endAt: true } },
      },
    }),
    prisma.calendarEvent.findMany({
      select: { id: true, title: true, startAt: true, endAt: true, location: true },
    }),
  ]);
  return {
    context,
    ownerIndex: buildOwnerIndex(context),
    conflicts,
    calendarEvents,
  };
}

function buildPlanningItemsForAffected(
  affectedIds: Set<string>,
  ownerIndex: Map<string, OwnerMeta>,
): { items: PlanningItem[]; skipped: Array<{ ownerId: string; title: string; reason: string }> } {
  const items: PlanningItem[] = [];
  const skipped: Array<{ ownerId: string; title: string; reason: string }> = [];

  for (const ownerId of affectedIds) {
    const owner = ownerIndex.get(ownerId);
    if (!owner) {
      skipped.push({ ownerId, title: ownerId, reason: "对象不存在" });
      continue;
    }
    if (owner.status === "DONE") {
      skipped.push({ ownerId, title: owner.title, reason: "已完成，无需重排" });
      continue;
    }
    if (owner.estimatedMinutes === null || owner.estimatedMinutes === undefined) {
      skipped.push({ ownerId, title: owner.title, reason: "缺少预计耗时" });
      continue;
    }
    if (owner.estimatedMinutes < 15 || owner.estimatedMinutes > 24 * 60) {
      skipped.push({ ownerId, title: owner.title, reason: `预计耗时 ${owner.estimatedMinutes} 超出可排范围` });
      continue;
    }

    items.push({
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      taskId: owner.taskId,
      title: owner.title,
      estimatedMinutes: owner.estimatedMinutes,
      deadline: owner.deadline ? owner.deadline.toISOString() : null,
      dependsOnOwnerIds: [...owner.dependsOnIds],
      priority: (PRIORITIES as readonly string[]).includes(owner.priority)
        ? (owner.priority as "LOW" | "MEDIUM" | "HIGH")
        : "MEDIUM",
    });
  }

  return { items, skipped };
}

export interface ReplanPreview {
  generatedAt: string;
  rangeStart: string;
  rangeEnd: string;
  conflictIds: string[];
  affectedOwners: Array<{ ownerType: "TASK" | "SUBTASK"; ownerId: string; title: string }>;
  oldBlocks: Array<{ scheduleId: string; ownerId: string; title: string; startAt: string; endAt: string }>;
  newBlocks: PlanBlock[];
  unresolved: UnscheduledItem[];
  explanations: string[];
}

/**
 * 生成重排预览：只对受影响 owner 重新排期，其余作为固定占用。
 * 不写库。
 */
export async function generateReplanPreview(
  conflictIds?: string[],
  now: Date = new Date(),
): Promise<ReplanPreview> {
  const { context, ownerIndex, conflicts, calendarEvents } = await loadReplanContext(now, conflictIds);

  if (conflicts.length === 0) {
    throw new ReplanError("NO_UNRESOLVED_CONFLICTS", "当前没有未解决的冲突，无需重排");
  }

  const directOwnerIds = conflicts
    .map((c) => scheduleOwnerId(c.scheduleA))
    .filter((id) => id.length > 0);

  const dependencies = context.tasks.flatMap((task) =>
    task.subTasks.flatMap((sub) =>
      sub.dependsOnIds.map((dep) => ({ subTaskId: sub.id, dependsOnId: dep })),
    ),
  );

  const affected = computeAffectedOwners({ directOwnerIds, dependencies });

  const affectedOwners = [...affected]
    .map((id) => ownerIndex.get(id))
    .filter((o): o is OwnerMeta => Boolean(o))
    .map((o) => ({ ownerType: o.ownerType, ownerId: o.ownerId, title: o.title }));

  // 旧计划块（被替代的 Schedule，仅展示，不删除）
  const oldBlocks = context.schedules
    .filter((s) => affected.has(scheduleOwnerId(s)))
    .map((s) => ({
      scheduleId: s.id,
      ownerId: scheduleOwnerId(s),
      title: s.subTask?.title ?? s.task?.title ?? "未命名日程",
      startAt: s.startAt.toISOString(),
      endAt: s.endAt.toISOString(),
    }));

  const { items, skipped } = buildPlanningItemsForAffected(affected, ownerIndex);

  // 固定占用 = 未受影响的有效 Schedule + 全部 CalendarEvent
  const busy: BusyInterval[] = [];
  for (const schedule of context.schedules) {
    const ownerId = scheduleOwnerId(schedule);
    if (affected.has(ownerId)) continue;
    busy.push({
      startAt: schedule.startAt,
      endAt: schedule.endAt,
      label: schedule.subTask?.title ?? schedule.task?.title ?? "已有日程",
    });
  }
  for (const event of calendarEvents) {
    busy.push({ startAt: event.startAt, endAt: event.endAt, label: `临时事件「${event.title}」` });
  }

  // 依赖就绪时间：未受影响的已排 owner + 已完成的前置
  const dependencyReadyAt: DependencyReady[] = [];
  for (const schedule of context.schedules) {
    const ownerId = scheduleOwnerId(schedule);
    if (affected.has(ownerId)) continue;
    dependencyReadyAt.push({
      ownerId,
      readyAt: schedule.endAt,
      title: schedule.subTask?.title ?? schedule.task?.title,
    });
  }
  for (const task of context.tasks) {
    if (task.status === "DONE") {
      dependencyReadyAt.push({ ownerId: task.id, readyAt: now, title: task.title });
    }
    for (const sub of task.subTasks) {
      if (sub.status === "DONE") {
        dependencyReadyAt.push({ ownerId: sub.id, readyAt: now, title: sub.title });
      }
    }
  }

  const rangeStart = now;
  const rangeEnd = addDays(now, MAX_RANGE_DAYS);

  const output = planSchedule({
    items,
    courses: context.courses,
    busy,
    dependencyReadyAt,
    rangeStart,
    rangeEnd,
    now,
  });

  // 为受影响 owner 的新块补充重排原因（前置冲突 / 依赖联动）
  const conflictOwnerIds = new Set(directOwnerIds);
  const enriched = output.blocks.map((block) => {
    const owner = ownerIndex.get(block.ownerId);
    if (!owner) return block;
    const wasDirect = conflictOwnerIds.has(owner.ownerId);
    const prefix = wasDirect
      ? `原计划与固定占用发生冲突，已取消原安排并重新寻找可用时段；`
      : `由于前置任务完成时间延后，该子任务最早开始时间同步后移；`;
    return { ...block, rationale: prefix + block.rationale };
  });

  const unscheduled = [...skipped.map((s) => ({ ownerType: "TASK" as const, ownerId: s.ownerId, title: s.title, reason: s.reason })), ...output.unscheduled];

  const explanations = conflicts.map((c) => c.description);

  return {
    generatedAt: now.toISOString(),
    rangeStart: rangeStart.toISOString(),
    rangeEnd: rangeEnd.toISOString(),
    conflictIds: conflicts.map((c) => c.id),
    affectedOwners,
    oldBlocks,
    newBlocks: enriched,
    unresolved: unscheduled,
    explanations,
  };
}

// ------------------------------------------------------------
// 确认重排
// ------------------------------------------------------------

interface ValidatedReplanBlock {
  block: PlanBlock;
  owner: OwnerMeta;
  startAt: Date;
  endAt: Date;
  duration: number;
}

function toMs(value: string): number {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) throw new ReplanError("BLOCK_INVALID", `时间非法：${value}`);
  return time;
}

function validateReplanBlock(
  block: PlanBlock,
  ownerIndex: Map<string, OwnerMeta>,
  affectedIds: Set<string>,
  context: PlanningContext,
  calendarEvents: Array<{ id: string; title: string; startAt: Date; endAt: Date }>,
  rangeStart: Date,
  rangeEnd: Date,
  now: Date,
): ValidatedReplanBlock {
  const owner = ownerIndex.get(block.ownerId);
  if (!owner) throw new ReplanError("OWNER_NOT_FOUND", `对象不存在：${block.ownerId}`);
  if (!affectedIds.has(owner.ownerId)) {
    throw new ReplanError("BLOCK_INVALID", `「${owner.title}」不在本次重排范围内`);
  }
  if (owner.ownerType !== block.ownerType) {
    throw new ReplanError("BLOCK_INVALID", `「${owner.title}」类型不匹配`);
  }
  if (owner.status === "DONE") {
    throw new ReplanError("BLOCK_INVALID", `「${owner.title}」已完成，不应重排`);
  }

  const startMs = toMs(block.startAt);
  const endMs = toMs(block.endAt);
  if (startMs >= endMs) throw new ReplanError("BLOCK_INVALID", `「${owner.title}」startAt 必须早于 endAt`);

  const startAt = new Date(startMs);
  const endAt = new Date(endMs);
  const duration = (endMs - startMs) / 60000;

  if (!Number.isInteger(duration) || duration < 30 || duration > 120 || duration % PLAN_GRID_MINUTES !== 0) {
    throw new ReplanError("BLOCK_INVALID", `「${owner.title}」单块时长 ${duration} 分钟须为 30~120 分钟内 30 的倍数`);
  }

  const startMinute = minuteOfDay(startAt);
  const endMinute = minuteOfDay(endAt);
  if (
    dateKey(startAt) !== dateKey(endAt) ||
    startMinute % PLAN_GRID_MINUTES !== 0 ||
    startMinute < PLAN_WINDOW_START_MINUTE ||
    endMinute > PLAN_WINDOW_END_MINUTE
  ) {
    throw new ReplanError("BLOCK_INVALID", `「${owner.title}」时段不在 08:00-22:00 的 30 分钟网格上`);
  }

  if (startMs < now.getTime()) {
    throw new ReplanError("BLOCK_IN_PAST", `「${owner.title}」开始时间已过去`);
  }
  if (startMs < rangeStart.getTime() || endMs > rangeEnd.getTime()) {
    throw new ReplanError("BLOCK_OUT_OF_RANGE", `「${owner.title}」超出重排范围`);
  }
  if (owner.deadline && endMs > owner.deadline.getTime()) {
    throw new ReplanError("DEADLINE_EXCEEDED", `「${owner.title}」超过截止时间`);
  }

  const weekday = weekdayOf(startAt);
  for (const course of context.courses) {
    if (
      course.dayOfWeek === weekday &&
      intervalsOverlap(startMinute, endMinute, course.startMinute, course.endMinute)
    ) {
      throw new ReplanError("COURSE_OVERLAP", `「${owner.title}」与课程「${course.title}」重叠`);
    }
  }

  for (const event of calendarEvents) {
    if (intervalsOverlap(startMs, endMs, event.startAt.getTime(), event.endAt.getTime())) {
      throw new ReplanError("CALENDAR_EVENT_OVERLAP", `「${owner.title}」与临时事件「${event.title}」重叠`);
    }
  }

  // 未受影响 Schedule 作为固定占用
  for (const schedule of context.schedules) {
    const ownerId = scheduleOwnerId(schedule);
    if (affectedIds.has(ownerId)) continue;
    if (intervalsOverlap(startMs, endMs, schedule.startAt.getTime(), schedule.endAt.getTime())) {
      throw new ReplanError(
        "SCHEDULE_OVERLAP",
        `「${owner.title}」与已有日程「${schedule.subTask?.title ?? schedule.task?.title}」重叠`,
      );
    }
  }

  return { block, owner, startAt, endAt, duration };
}

function assertReplanDependencies(
  validated: ValidatedReplanBlock[],
  ownerIndex: Map<string, OwnerMeta>,
  context: PlanningContext,
  affectedIds: Set<string>,
): void {
  const plannedFinish = new Map<string, number>();
  for (const entry of validated) {
    const current = plannedFinish.get(entry.owner.ownerId) ?? 0;
    plannedFinish.set(entry.owner.ownerId, Math.max(current, entry.endAt.getTime()));
  }
  const scheduledFinish = new Map<string, number>();
  for (const schedule of context.schedules) {
    const ownerId = scheduleOwnerId(schedule);
    if (affectedIds.has(ownerId)) continue;
    scheduledFinish.set(ownerId, Math.max(scheduledFinish.get(ownerId) ?? 0, schedule.endAt.getTime()));
  }

  for (const entry of validated) {
    const { owner } = entry;
    if (owner.dependsOnIds.length === 0) continue;
    let readyAt = 0;
    const blockers: string[] = [];
    for (const depId of owner.dependsOnIds) {
      const dep = ownerIndex.get(depId);
      if (!dep) throw new ReplanError("DEPENDENCY_VIOLATION", `「${owner.title}」依赖对象不存在`);
      if (dep.status === "DONE") continue;
      const finish = Math.max(scheduledFinish.get(depId) ?? 0, plannedFinish.get(depId) ?? 0);
      if (finish <= 0) {
        blockers.push(dep.title);
        continue;
      }
      readyAt = Math.max(readyAt, finish);
    }
    if (blockers.length > 0) {
      throw new ReplanError("DEPENDENCY_VIOLATION", `「${owner.title}」前置未安排：${blockers.join("、")}`);
    }
    if (entry.startAt.getTime() < readyAt) {
      throw new ReplanError(
        "DEPENDENCY_VIOLATION",
        `「${owner.title}」开始时间早于前置完成时间`,
      );
    }
  }
}

function assertReplanDurations(validated: ValidatedReplanBlock[]): void {
  const totals = new Map<string, { minutes: number; owner: OwnerMeta }>();
  for (const entry of validated) {
    const current = totals.get(entry.owner.ownerId) ?? { minutes: 0, owner: entry.owner };
    current.minutes += entry.duration;
    totals.set(entry.owner.ownerId, current);
  }
  for (const { minutes, owner } of totals.values()) {
    if (owner.estimatedMinutes === null) {
      throw new ReplanError("DURATION_MISMATCH", `「${owner.title}」缺少预计耗时`);
    }
    const expected = planMinutesFor(owner.estimatedMinutes);
    if (minutes !== expected) {
      throw new ReplanError(
        "DURATION_MISMATCH",
        `「${owner.title}」总时长 ${minutes} 分钟，与取整后 ${expected} 分钟不一致`,
      );
    }
  }
}

export interface ConfirmReplanInput {
  conflictIds: string[];
  blocks: PlanBlock[];
  rangeStart: string;
  rangeEnd: string;
}

export interface ApplyReplanParams {
  conflictIds: string[];
  blocks: Array<{
    ownerType: "TASK" | "SUBTASK";
    ownerId: string;
    taskId: string;
    title: string;
    startAt: string;
    endAt: string;
    rationale: string;
  }>;
  oldScheduleIds: string[];
  resolution: string;
  conflictSummary: string;
  affectedOwnerCount: number;
}

/**
 * 在事务内执行重排写入：取消旧 Schedule → 创建新 Schedule → 解决 Conflict → 写 DecisionLog。
 * 单独导出便于验证事务回滚。
 */
export async function applyReplan(
  tx: Prisma.TransactionClient,
  params: ApplyReplanParams,
): Promise<{ scheduleIds: string[]; decisionLogId: string }> {
  // 1. 二次确认冲突仍未解决（防重复点击）
  const stillUnresolved = await tx.conflict.count({
    where: { id: { in: params.conflictIds }, resolvedAt: null },
  });
  if (stillUnresolved !== params.conflictIds.length) {
    throw new ReplanError(
      "CONFLICT_ALREADY_RESOLVED",
      "部分冲突已被解决，拒绝重复重排",
    );
  }

  // 2. 二次确认旧 Schedule 仍有效
  const oldSchedules = await tx.schedule.findMany({
    where: { id: { in: params.oldScheduleIds }, status: { not: "CANCELLED" } },
    select: { id: true, taskId: true, subTaskId: true },
  });
  if (oldSchedules.length !== params.oldScheduleIds.length) {
    throw new ReplanError("OLD_SCHEDULE_GONE", "部分被替代的日程已不存在或已取消");
  }

  // 3. 旧 Schedule → CANCELLED（保留历史，不删除）
  await tx.schedule.updateMany({
    where: { id: { in: params.oldScheduleIds } },
    data: { status: "CANCELLED" },
  });

  // 4. 创建新 Schedule（CONFIRMED）
  const scheduleIds: string[] = [];
  for (const block of params.blocks) {
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

  // 5. 解决 Conflict
  await tx.conflict.updateMany({
    where: { id: { in: params.conflictIds } },
    data: { resolution: params.resolution, resolvedAt: new Date() },
  });

  // 6. DecisionLog（REPLAN）
  const log = await tx.decisionLog.create({
    data: {
      actionType: "REPLAN",
      inputSummary: `冲突 ${params.conflictIds.length} 个；受影响 owner ${params.affectedOwnerCount} 个；${params.conflictSummary}`,
      outputSummary: params.resolution,
      evidence: JSON.stringify({
        strategy: "只重排受冲突影响的 owner 及其下游依赖，复用 S4 确定性排期引擎",
        conflictIds: params.conflictIds,
        cancelledScheduleIds: params.oldScheduleIds,
        newScheduleIds: scheduleIds,
        blocks: params.blocks,
      }),
      relatedTaskId: params.blocks[0]?.taskId ?? null,
    },
  });

  return { scheduleIds, decisionLogId: log.id };
}

export interface ConfirmReplanResult {
  scheduleIds: string[];
  decisionLogId: string;
  cancelledCount: number;
  createdCount: number;
}

/**
 * 确认重排：重新查询 → 重新校验全部约束 → 事务写入。
 * 客户端提交的块永不被直接信任。
 */
export async function confirmReplan(
  payload: ConfirmReplanInput,
  now: Date = new Date(),
): Promise<ConfirmReplanResult> {
  if (!Array.isArray(payload.conflictIds) || payload.conflictIds.length === 0) {
    throw new ReplanError("VALIDATION_FAILED", "必须提供 conflictIds");
  }
  if (!Array.isArray(payload.blocks) || payload.blocks.length === 0) {
    throw new ReplanError("VALIDATION_FAILED", "必须提供重排计划块");
  }

  const rangeStart = new Date(payload.rangeStart);
  const rangeEnd = new Date(payload.rangeEnd);
  if (rangeStart.getTime() >= rangeEnd.getTime()) {
    throw new ReplanError("VALIDATION_FAILED", "rangeStart 必须早于 rangeEnd");
  }

  const { context, ownerIndex, conflicts, calendarEvents } = await loadReplanContext(now);

  const conflictById = new Map(conflicts.map((c) => [c.id, c]));
  for (const id of payload.conflictIds) {
    if (!conflictById.has(id)) {
      throw new ReplanError("CONFLICT_ALREADY_RESOLVED", `冲突不存在或已解决：${id}`);
    }
  }
  const selectedConflicts = payload.conflictIds.map((id) => conflictById.get(id) as ConflictWithSchedule);

  const directOwnerIds = selectedConflicts
    .map((c) => scheduleOwnerId(c.scheduleA))
    .filter((id) => id.length > 0);
  const dependencies = context.tasks.flatMap((task) =>
    task.subTasks.flatMap((sub) =>
      sub.dependsOnIds.map((dep) => ({ subTaskId: sub.id, dependsOnId: dep })),
    ),
  );
  const affected = computeAffectedOwners({ directOwnerIds, dependencies });

  const validated = payload.blocks.map((block) =>
    validateReplanBlock(block, ownerIndex, affected, context, calendarEvents, rangeStart, rangeEnd, now),
  );

  // 内部不互撞
  for (let i = 0; i < validated.length; i += 1) {
    for (let j = i + 1; j < validated.length; j += 1) {
      const a = validated[i];
      const b = validated[j];
      if (intervalsOverlap(a.startAt.getTime(), a.endAt.getTime(), b.startAt.getTime(), b.endAt.getTime())) {
        throw new ReplanError("BLOCK_OVERLAP", `计划块重叠：「${a.owner.title}」与「${b.owner.title}」`);
      }
    }
  }

  assertReplanDependencies(validated, ownerIndex, context, affected);
  assertReplanDurations(validated);

  // 收集被替代的旧 Schedule
  const oldScheduleIds = context.schedules
    .filter((s) => affected.has(scheduleOwnerId(s)))
    .map((s) => s.id);

  const writable = validated.map((entry) => ({
    ownerType: entry.owner.ownerType,
    ownerId: entry.owner.ownerId,
    taskId: entry.owner.taskId,
    title: entry.owner.title,
    startAt: entry.startAt.toISOString(),
    endAt: entry.endAt.toISOString(),
    rationale: entry.block.rationale,
  }));

  const resolutionParts = writable.map(
    (b) => `「${b.title}」${formatTime(new Date(b.startAt))}-${formatTime(new Date(b.endAt))}`,
  );
  const resolution = `已将 ${writable.length} 个计划块重新安排：${resolutionParts.join("；")}。原计划已标记为 CANCELLED 保留历史。`;

  const conflictSummary = selectedConflicts.map((c) => c.description).join("；");

  const result = await prisma.$transaction((tx) =>
    applyReplan(tx, {
      conflictIds: payload.conflictIds,
      blocks: writable,
      oldScheduleIds,
      resolution,
      conflictSummary,
      affectedOwnerCount: affected.size,
    }),
  );

  return {
    scheduleIds: result.scheduleIds,
    decisionLogId: result.decisionLogId,
    cancelledCount: oldScheduleIds.length,
    createdCount: result.scheduleIds.length,
  };
}
