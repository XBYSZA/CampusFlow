import { z } from "zod";

// ============================================================
// 排期契约（S4）
// PlanningEngine 的输入 / 输出与服务端 confirm 入参统一在这里定义，
// UI 只消费这些结构，不另立一套。
// ============================================================

export const OWNER_TYPES = ["TASK", "SUBTASK"] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

export const DONE_TASK_STATUS = "DONE";

/** 排期引擎输入：每个待安排对象一条 */
export const planningItemSchema = z.object({
  ownerType: z.enum(OWNER_TYPES),
  ownerId: z.string().min(1),
  taskId: z.string().min(1),
  title: z.string().min(1).max(200),
  estimatedMinutes: z.number().int().min(15).max(24 * 60),
  deadline: z.iso.datetime({ offset: true }).nullable(),
  dependsOnOwnerIds: z.array(z.string().min(1)).default([]),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]),
});

export type PlanningItem = z.infer<typeof planningItemSchema>;

/** 计划块：预览与确认共用同一结构 */
export const planBlockSchema = z.object({
  clientId: z.string().min(1),
  ownerType: z.enum(OWNER_TYPES),
  ownerId: z.string().min(1),
  title: z.string().min(1).max(200),
  startAt: z.iso.datetime({ offset: true }),
  endAt: z.iso.datetime({ offset: true }),
  /** 规则引擎根据真实数据生成，禁止模板废话 */
  rationale: z.string().min(5).max(1000),
});

export type PlanBlock = z.infer<typeof planBlockSchema>;

export const unscheduledItemSchema = z.object({
  ownerType: z.enum(OWNER_TYPES),
  ownerId: z.string().min(1),
  title: z.string().min(1).max(200),
  reason: z.string().min(1).max(300),
});

export type UnscheduledItem = z.infer<typeof unscheduledItemSchema>;

export const planPreviewSchema = z.object({
  generatedAt: z.iso.datetime({ offset: true }),
  rangeStart: z.iso.datetime({ offset: true }),
  rangeEnd: z.iso.datetime({ offset: true }),
  strategy: z.string().min(1).max(300),
  blocks: z.array(planBlockSchema),
  unscheduled: z.array(unscheduledItemSchema),
});

export type PlanPreview = z.infer<typeof planPreviewSchema>;

/**
 * confirm 入参：只提交预览中的计划块与范围。
 * 服务端会重新查询数据库并全部重新校验，绝不直接信任这些块。
 * unscheduled 仅用于 DecisionLog 留痕（记录本次未被安排的项目及原因），不参与排期计算。
 */
export const confirmPlanPayloadSchema = z.object({
  rangeStart: z.iso.datetime({ offset: true }),
  rangeEnd: z.iso.datetime({ offset: true }),
  blocks: z.array(planBlockSchema).min(1).max(300),
  unscheduled: z.array(unscheduledItemSchema).max(100).optional().default([]),
});

export type ConfirmPlanPayload = z.infer<typeof confirmPlanPayloadSchema>;

// ============================================================
// 周视图数据（GET /api/schedule）
// 纯数据结构，不含服务端依赖，页面只 import type 使用。
// ============================================================

export interface WeekCourseBlock {
  id: string;
  title: string;
  location: string | null;
  startMinute: number;
  endMinute: number;
  /** 该课程在本周这一天的实际开始/结束时刻（ISO） */
  startAt: string;
  endAt: string;
}

export interface WeekScheduleBlock {
  id: string;
  ownerType: OwnerType;
  ownerId: string;
  title: string;
  startAt: string;
  endAt: string;
  status: string;
  rationale: string | null;
}

export interface WeekDay {
  /** YYYY-MM-DD（Asia/Shanghai） */
  dateKey: string;
  /** 0=周日 ... 6=周六 */
  weekday: number;
  courses: WeekCourseBlock[];
  schedules: WeekScheduleBlock[];
}

export interface WeekScheduleView {
  weekStart: string;
  weekEnd: string;
  days: WeekDay[];
  /** 当前待安排（尚未有正式日程、未完成）的对象数量 */
  pendingCount: number;
}

/** 由于 30 分钟粒度，估算时长向上取整到 30 的倍数 */
export function planMinutesFor(estimatedMinutes: number): number {
  return Math.ceil(estimatedMinutes / 30) * 30;
}

/** 单块上限 120 分钟；返回各块分钟数，总和等于计划时长 */
export function splitIntoChunks(plannedMinutes: number, maxBlock = 120): number[] {
  if (plannedMinutes <= 0) return [];
  const chunks: number[] = [];
  let remaining = plannedMinutes;
  while (remaining > maxBlock) {
    chunks.push(maxBlock);
    remaining -= maxBlock;
  }
  if (remaining > 0) chunks.push(remaining);
  return chunks;
}
