// 领域取值范围与校验结构
// 背景：SQLite 不在数据库层校验枚举值，所有受约束字段统一在这里定义与校验

export const SOURCE_TYPES = ["NOTICE", "GROUP_CHAT", "PDF_TEXT"] as const;
export const PRIORITIES = ["LOW", "MEDIUM", "HIGH"] as const;
export const TASK_STATUSES = ["TODO", "IN_PROGRESS", "DONE"] as const;
export const SCHEDULE_STATUSES = ["PROPOSED", "CONFIRMED", "MOVED", "CANCELLED"] as const;
export const CONFLICT_TYPES = ["OVERLAP", "DEADLINE_RISK"] as const;
export const DECISION_ACTIONS = [
  "EXTRACT",
  "DECOMPOSE",
  "PLAN",
  "RESOLVE_CONFLICT",
  "REPLAN",
  "COMPLETE",
] as const;
export const CALENDAR_EVENT_TYPES = ["LECTURE", "MEETING", "CLUB", "OTHER"] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];
export type ConflictType = (typeof CONFLICT_TYPES)[number];
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

// 星期取值：0=周日 1=周一 ... 6=周六（与 JS Date.getDay() 一致）
export const DAY_OF_WEEK_MIN = 0;
export const DAY_OF_WEEK_MAX = 6;

// 一天内的分钟数：0（00:00）至 1440（24:00），且要求 endMinute > startMinute
export const MINUTE_OF_DAY_MIN = 0;
export const MINUTE_OF_DAY_MAX = 1440;

export function isValidEnum<T extends readonly string[]>(
  values: T,
  value: string,
): value is T[number] {
  return (values as readonly string[]).includes(value);
}

export function isValidDayOfWeek(value: number): boolean {
  return Number.isInteger(value) && value >= DAY_OF_WEEK_MIN && value <= DAY_OF_WEEK_MAX;
}

export function isValidCourseMinutes(startMinute: number, endMinute: number): boolean {
  return (
    Number.isInteger(startMinute) &&
    Number.isInteger(endMinute) &&
    startMinute >= MINUTE_OF_DAY_MIN &&
    startMinute <= MINUTE_OF_DAY_MAX &&
    endMinute >= MINUTE_OF_DAY_MIN &&
    endMinute <= MINUTE_OF_DAY_MAX &&
    endMinute > startMinute
  );
}

// Schedule 关联互斥校验：taskId 与 subTaskId 必须恰好二选一
export type ScheduleOwnerInput = { taskId?: string | null; subTaskId?: string | null };

export function validateScheduleOwner(input: ScheduleOwnerInput): string | null {
  const hasTask = typeof input.taskId === "string" && input.taskId.length > 0;
  const hasSubTask = typeof input.subTaskId === "string" && input.subTaskId.length > 0;
  if (hasTask && hasSubTask) return "Schedule 不能同时关联 Task 和 SubTask";
  if (!hasTask && !hasSubTask) return "Schedule 必须关联 Task 或 SubTask 之一";
  return null;
}

// Conflict 参与方校验：scheduleA 必填（数据库层保证），
// 固定占用方 scheduleB / course / calendarEvent 必须恰好三选一（应用层保证）
export type ConflictParticipantsInput = {
  scheduleBId?: string | null;
  courseId?: string | null;
  calendarEventId?: string | null;
};

export function validateConflictParticipants(input: ConflictParticipantsInput): string | null {
  const hasScheduleB = typeof input.scheduleBId === "string" && input.scheduleBId.length > 0;
  const hasCourse = typeof input.courseId === "string" && input.courseId.length > 0;
  const hasCalendarEvent =
    typeof input.calendarEventId === "string" && input.calendarEventId.length > 0;
  const count = [hasScheduleB, hasCourse, hasCalendarEvent].filter(Boolean).length;
  if (count === 0) return "Conflict 必须包含固定占用方（Schedule / Course / CalendarEvent）";
  if (count > 1) return "Conflict 固定占用方只能选择 Schedule、Course 或 CalendarEvent 之一";
  return null;
}

// CalendarEvent 校验：标题非空，startAt < endAt
export type CalendarEventInput = {
  title: string;
  startAt: Date;
  endAt: Date;
  eventType?: string;
};

export function validateCalendarEvent(input: CalendarEventInput): string | null {
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    return "CalendarEvent 标题不能为空";
  }
  if (!(input.startAt instanceof Date) || Number.isNaN(input.startAt.getTime())) {
    return "CalendarEvent startAt 非法";
  }
  if (!(input.endAt instanceof Date) || Number.isNaN(input.endAt.getTime())) {
    return "CalendarEvent endAt 非法";
  }
  if (input.endAt.getTime() <= input.startAt.getTime()) {
    return "CalendarEvent endAt 必须晚于 startAt";
  }
  if (input.eventType !== undefined && !isValidEnum(CALENDAR_EVENT_TYPES, input.eventType)) {
    return `CalendarEvent eventType 非法：${input.eventType}`;
  }
  return null;
}

// 子任务依赖环检测：纯函数，供创建依赖前后校验使用
export type DependencyEdge = { subTaskId: string; dependsOnId: string };

// 返回构成环的一条边（形成闭环的依赖），无环时返回 null
export function findDependencyCycle(edges: DependencyEdge[]): DependencyEdge | null {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.subTaskId) ?? [];
    list.push(edge.dependsOnId);
    adjacency.set(edge.subTaskId, list);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (node: string): DependencyEdge | null => {
    if (visited.has(node)) return null;
    if (visiting.has(node)) return null; // 由外层记录回边
    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (visiting.has(next)) return { subTaskId: node, dependsOnId: next };
      const found = visit(next);
      if (found) return found;
    }
    visiting.delete(node);
    visited.add(node);
    return null;
  };

  for (const node of adjacency.keys()) {
    const found = visit(node);
    if (found) return found;
  }
  return null;
}
