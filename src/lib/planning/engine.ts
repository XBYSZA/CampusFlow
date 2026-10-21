import { findDependencyCycle } from "@/lib/domain";
import {
  formatDateTime,
  addMinutes,
  dateKey,
  minuteOfDay,
  ceilToGridMinute,
  PLAN_GRID_MINUTES,
  PLAN_WINDOW_END_MINUTE,
  PLAN_WINDOW_START_MINUTE,
  shanghaiParts,
  shanghaiDate,
  weekdayOf,
} from "@/lib/time";
import {
  planMinutesFor,
  splitIntoChunks,
  type PlanBlock,
  type PlanningItem,
  type UnscheduledItem,
} from "./contract";

// ============================================================
// 确定性排期引擎（S4）
// LLM 不参与具体时间决策：同一输入 + 同一 now 必须产出同一结果。
// 纯函数，不访问数据库，便于测试。
// ============================================================

export interface CourseConstraint {
  id: string;
  title: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  location?: string | null;
}

export interface BusyInterval {
  startAt: Date;
  endAt: Date;
  label?: string;
}

/** 已满足的前置关系（不在本次待排集合内，但完成时间可能在未来） */
export interface DependencyReady {
  ownerId: string;
  readyAt: Date;
  /** 前置对象标题，用于生成可读的 rationale */
  title?: string;
}

export interface PlanInput {
  items: PlanningItem[];
  courses: CourseConstraint[];
  busy: BusyInterval[];
  dependencyReadyAt?: DependencyReady[];
  rangeStart: Date;
  rangeEnd: Date;
  now: Date;
}

export interface PlanOutput {
  blocks: PlanBlock[];
  unscheduled: UnscheduledItem[];
}

export const PLAN_STRATEGY =
  "按截止时间 → 优先级 → 依赖顺序稳定排序，在 08:00-22:00 的 30 分钟网格上贪心寻找空闲时段，单块最长 120 分钟";

interface Occupancy {
  start: number;
  end: number;
  label: string;
}

interface PlanDay {
  key: string;
  start: Date;
  weekday: number;
  occupancy: Occupancy[];
}

interface Slot {
  startAt: Date;
  endAt: Date;
}

const MAX_RANGE_DAYS = 31;
const MAX_BLOCK_MINUTES = 120;
const PRIORITY_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

function buildDays(input: PlanInput): PlanDay[] {
  const days: PlanDay[] = [];
  const startParts = shanghaiParts(input.rangeStart);
  let dayStart = shanghaiDate(startParts.year, startParts.month, startParts.day, 0, 0);

  for (let i = 0; i < MAX_RANGE_DAYS; i += 1) {
    const dayEnd = addMinutes(dayStart, 24 * 60);
    if (dayStart.getTime() >= input.rangeEnd.getTime()) break;

    const day: PlanDay = {
      key: dateKey(dayStart),
      start: dayStart,
      weekday: weekdayOf(dayStart),
      occupancy: [],
    };

    // 固定课程：每周重复
    for (const course of input.courses) {
      if (course.dayOfWeek === day.weekday) {
        day.occupancy.push({
          start: course.startMinute,
          end: course.endMinute,
          label: `课程「${course.title}」`,
        });
      }
    }

    // 已有日程：按天裁剪成分钟区间
    for (const busy of input.busy) {
      const overlapStart = Math.max(busy.startAt.getTime(), dayStart.getTime());
      const overlapEnd = Math.min(busy.endAt.getTime(), dayEnd.getTime());
      if (overlapStart >= overlapEnd) continue;
      day.occupancy.push({
        start: overlapStart === dayStart.getTime() ? 0 : minuteOfDay(new Date(overlapStart)),
        end: overlapEnd === dayEnd.getTime() ? 24 * 60 : minuteOfDay(new Date(overlapEnd)),
        label: busy.label ?? "已有日程",
      });
    }

    days.push(day);
    dayStart = dayEnd;
  }

  return days;
}

function isFree(day: PlanDay, start: number, end: number): boolean {
  return !day.occupancy.some((occ) => start < occ.end && occ.start < end);
}

function findSlot(
  days: PlanDay[],
  cursor: Date,
  duration: number,
  deadline: Date | null,
  rangeEnd: Date,
): Slot | null {
  for (const day of days) {
    const dayClose = addMinutes(day.start, PLAN_WINDOW_END_MINUTE);
    if (dayClose.getTime() <= cursor.getTime()) continue;
    if (deadline && day.start.getTime() > deadline.getTime()) break;

    const sameDay = dateKey(cursor) === day.key;
    const firstMinute = Math.max(
      PLAN_WINDOW_START_MINUTE,
      sameDay ? ceilToGridMinute(minuteOfDay(cursor), PLAN_GRID_MINUTES) : PLAN_WINDOW_START_MINUTE,
    );

    for (let minute = firstMinute; minute + duration <= PLAN_WINDOW_END_MINUTE; minute += PLAN_GRID_MINUTES) {
      const startAt = addMinutes(day.start, minute);
      const endAt = addMinutes(day.start, minute + duration);
      if (startAt.getTime() < cursor.getTime()) continue;
      if (deadline && endAt.getTime() > deadline.getTime()) break;
      if (endAt.getTime() > rangeEnd.getTime()) return null;
      if (isFree(day, minute, minute + duration)) {
        return { startAt, endAt };
      }
    }
  }
  return null;
}

function buildRationale(params: {
  item: PlanningItem;
  plannedMinutes: number;
  chunkIndex: number;
  chunkCount: number;
  dependencyNotes: string[];
}): string {
  const { item, plannedMinutes, chunkIndex, chunkCount, dependencyNotes } = params;
  const parts: string[] = [];

  parts.push(
    item.deadline
      ? `截止 ${formatDateTime(new Date(item.deadline))}`
      : "未设置截止时间",
  );
  parts.push(
    plannedMinutes === item.estimatedMinutes
      ? `预计 ${item.estimatedMinutes} 分钟`
      : `预计 ${item.estimatedMinutes} 分钟，按 30 分钟粒度取整为 ${plannedMinutes} 分钟`,
  );
  if (chunkCount > 1) {
    parts.push(`第 ${chunkIndex + 1}/${chunkCount} 块`);
  }
  if (dependencyNotes.length > 0) {
    parts.push(`前置 ${dependencyNotes.join("、")}`);
  }
  parts.push("该时段没有课程与已确认日程占用");

  return `${parts.join("；")}，因此安排在此。`;
}

interface PlacedItem {
  blocks: PlanBlock[];
  finishAt: Date;
}

function placeItem(
  item: PlanningItem,
  days: PlanDay[],
  cursorStart: Date,
  deadline: Date | null,
  rangeEnd: Date,
): PlacedItem | { reason: string } {
  const plannedMinutes = planMinutesFor(item.estimatedMinutes);
  const chunks = splitIntoChunks(plannedMinutes, MAX_BLOCK_MINUTES);

  const blocks: PlanBlock[] = [];
  const committed: Array<{ day: PlanDay; start: number; end: number }> = [];
  let cursor = cursorStart;

  for (let index = 0; index < chunks.length; index += 1) {
    const slot = findSlot(days, cursor, chunks[index], deadline, rangeEnd);
    if (!slot) {
      // 任意一块失败：撤回本次已经占用的时段，整体放弃该任务
      for (const entry of committed) {
        const pos = entry.day.occupancy.findIndex(
          (occ) => occ.start === entry.start && occ.end === entry.end,
        );
        if (pos >= 0) entry.day.occupancy.splice(pos, 1);
      }
      return {
        reason: deadline
          ? `截止时间前没有足够的空闲时段（需要 ${plannedMinutes} 分钟，已避开课程与已有日程）`
          : `计划范围内没有足够的空闲时段（需要 ${plannedMinutes} 分钟）`,
      };
    }

    const startMinute = minuteOfDay(slot.startAt);
    const endMinute = startMinute + chunks[index];
    blocks.push({
      clientId: `blk-${item.ownerType.toLowerCase()}-${item.ownerId}-${index + 1}`,
      ownerType: item.ownerType,
      ownerId: item.ownerId,
      title: item.title,
      startAt: slot.startAt.toISOString(),
      endAt: slot.endAt.toISOString(),
      rationale: "",
    });

    const day = days.find((d) => d.key === dateKey(slot.startAt));
    if (!day) {
      return { reason: "排期范围内出现无法识别的日期，已放弃该任务" };
    }
    // 占位后继续找下一块，保证同一任务的多块之间互不重叠
    day.occupancy.push({ start: startMinute, end: endMinute, label: `本次计划「${item.title}」` });
    committed.push({ day, start: startMinute, end: endMinute });

    cursor = slot.endAt;
  }

  return { blocks, finishAt: cursor };
}

/**
 * 确定性贪心排期。
 * 依赖通过"每轮只安排前置已完成的项"保证；若某一轮没有任何进展，
 * 剩余项判定为依赖无法满足（防御异常数据）。
 */
export function planSchedule(input: PlanInput): PlanOutput {
  const items = input.items.filter((item) => item);
  const days = buildDays(input);

  // 防御：正式依赖已在 S3 校验，这里仍检测一次环，避免异常数据导致死循环
  const itemIds = new Set(items.map((item) => item.ownerId));
  const edges = items.flatMap((item) =>
    item.dependsOnOwnerIds
      .filter((dep) => itemIds.has(dep))
      .map((dep) => ({ subTaskId: item.ownerId, dependsOnId: dep })),
  );
  const cycle = findDependencyCycle(edges);
  if (cycle) {
    return {
      blocks: [],
      unscheduled: items.map((item) => ({
        ownerType: item.ownerType,
        ownerId: item.ownerId,
        title: item.title,
        reason: `依赖关系异常：检测到环 ${cycle.subTaskId} → ${cycle.dependsOnId}`,
      })),
    };
  }

  const unscheduled: UnscheduledItem[] = [];
  const pending = [...items];

  // 先剔除无截止 / 截止已过的项
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    const item = pending[i];
    if (!item.deadline) {
      unscheduled.push({
        ownerType: item.ownerType,
        ownerId: item.ownerId,
        title: item.title,
        reason: "缺少截止时间，未自动排期",
      });
      pending.splice(i, 1);
    } else if (new Date(item.deadline).getTime() <= input.now.getTime()) {
      unscheduled.push({
        ownerType: item.ownerType,
        ownerId: item.ownerId,
        title: item.title,
        reason: "截止时间已过，无法安排",
      });
      pending.splice(i, 1);
    }
  }

  // 稳定排序：截止时间早优先 → 优先级 → ownerId（兜底保证确定性）
  pending.sort((a, b) => {
    const deadlineA = a.deadline ? new Date(a.deadline).getTime() : Number.POSITIVE_INFINITY;
    const deadlineB = b.deadline ? new Date(b.deadline).getTime() : Number.POSITIVE_INFINITY;
    if (deadlineA !== deadlineB) return deadlineA - deadlineB;
    const rankA = PRIORITY_RANK[a.priority] ?? 9;
    const rankB = PRIORITY_RANK[b.priority] ?? 9;
    if (rankA !== rankB) return rankA - rankB;
    return a.ownerId.localeCompare(b.ownerId);
  });

  const readyAt = new Map<string, Date>();
  for (const dep of input.dependencyReadyAt ?? []) readyAt.set(dep.ownerId, dep.readyAt);

  // 标题映射：本次待排对象 + 已排期前置对象（用于生成可读 rationale）
  const titleById = new Map(items.map((entry) => [entry.ownerId, entry.title]));
  for (const dep of input.dependencyReadyAt ?? []) {
    if (dep.title) titleById.set(dep.ownerId, dep.title);
  }

  const finishAt = new Map<string, Date>();
  const blocks: PlanBlock[] = [];

  while (pending.length > 0) {
    let progressed = false;

    for (let index = 0; index < pending.length; ) {
      const item = pending[index];
      const depsInPlan = item.dependsOnOwnerIds.filter((dep) => itemIds.has(dep));
      const depsDone = depsInPlan.every((dep) => finishAt.has(dep));
      if (!depsDone) {
        index += 1;
        continue;
      }

      let earliest = new Date(Math.max(input.now.getTime(), input.rangeStart.getTime()));
      const dependencyNotes: string[] = [];
      let dependencyMissing = false;

      for (const depId of item.dependsOnOwnerIds) {
        let depReady: Date | undefined;
        if (finishAt.has(depId)) {
          depReady = finishAt.get(depId);
        } else if (readyAt.has(depId)) {
          depReady = readyAt.get(depId);
        } else if (!itemIds.has(depId)) {
          // 不在本次集合内、也没有日程信息：视为已完成（例如 DONE 的子任务）
          depReady = input.now;
        } else {
          dependencyMissing = true;
          break;
        }
        if (depReady && depReady.getTime() > earliest.getTime()) earliest = depReady;
        if (depReady && depReady.getTime() > input.now.getTime()) {
          dependencyNotes.push(
            `「${titleById.get(depId) ?? depId}」已于 ${formatDateTime(depReady)} 完成`,
          );
        }
      }

      if (dependencyMissing) {
        index += 1;
        continue;
      }

      const placed = placeItem(
        item,
        days,
        earliest,
        item.deadline ? new Date(item.deadline) : null,
        input.rangeEnd,
      );

      if ("reason" in placed) {
        unscheduled.push({
          ownerType: item.ownerType,
          ownerId: item.ownerId,
          title: item.title,
          reason: placed.reason,
        });
      } else {
        const plannedMinutes = planMinutesFor(item.estimatedMinutes);
        placed.blocks.forEach((block, chunkIndex) => {
          block.rationale = buildRationale({
            item,
            plannedMinutes,
            chunkIndex,
            chunkCount: placed.blocks.length,
            dependencyNotes,
          });
        });
        blocks.push(...placed.blocks);
        finishAt.set(item.ownerId, placed.finishAt);
      }

      pending.splice(index, 1);
      progressed = true;
    }

    if (!progressed) {
      for (const item of pending) {
        unscheduled.push({
          ownerType: item.ownerType,
          ownerId: item.ownerId,
          title: item.title,
          reason: "依赖的前置任务未能排期",
        });
      }
      break;
    }
  }

  blocks.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
  return { blocks, unscheduled };
}
