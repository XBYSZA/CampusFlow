import { z } from "zod";

// ============================================================
// 决策解释统一展示契约（S7）
//
// 把 S2-S6 已存在的 DecisionLog / Source / Evidence / Schedule /
// Conflict 聚合成一条用户可读的「决策解释链」。
//
// 角色约定：
// - AI          ：信息理解（EXTRACT）、任务拆解（DECOMPOSE）
// - RULE_ENGINE ：时间排期（PLAN）、冲突重排（REPLAN），确定性规则
// - HUMAN       ：每个正式结果都经用户确认后写入（confirmedNote）
// - SYSTEM      ：保留枚举，本阶段暂无使用
//
// aiContext 仅为「AI 调用上下文」（provider/model/promptVersion/耗时），
// 用于展示与调试，不是不可篡改的审计证据。
// ============================================================

export const decisionActorSchema = z.enum(["AI", "RULE_ENGINE", "HUMAN", "SYSTEM"]);
export type DecisionActor = z.infer<typeof decisionActorSchema>;

export const decisionStageTypeSchema = z.enum([
  "EXTRACT",
  "DECOMPOSE",
  "PLAN",
  "REPLAN",
  "COMPLETE",
]);
export type DecisionStageType = z.infer<typeof decisionStageTypeSchema>;

export const decisionDetailSchema = z.object({
  label: z.string().max(200),
  value: z.string().max(2000),
});
export type DecisionDetail = z.infer<typeof decisionDetailSchema>;

export const decisionEvidenceItemSchema = z.object({
  quote: z.string().min(1).max(1000),
  field: z.string().max(60).nullable().optional(),
  /** quote 在原文中的上下文片段（服务端截取，便于用户对照） */
  context: z.string().max(600).nullable().optional(),
});
export type DecisionEvidenceItem = z.infer<typeof decisionEvidenceItemSchema>;

/** AI 调用上下文（展示/调试元数据，非审计证据） */
export const aiCallContextSchema = z.object({
  provider: z.string().max(20),
  model: z.string().max(120).nullable(),
  promptVersion: z.string().max(60).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
});
export type AICallContext = z.infer<typeof aiCallContextSchema>;

export const decisionStageSchema = z.object({
  id: z.string().min(1),
  type: decisionStageTypeSchema,
  title: z.string().max(120),
  actor: decisionActorSchema,
  /** ISO 时间（DecisionLog.createdAt） */
  timestamp: z.string(),
  summary: z.string().max(2000),
  details: z.array(decisionDetailSchema).max(50),
  evidence: z.array(decisionEvidenceItemSchema).max(50),
  aiContext: aiCallContextSchema.nullable(),
  /** 人工确认说明（不伪造具体时间与身份） */
  confirmedNote: z.string().max(200),
});
export type DecisionStage = z.infer<typeof decisionStageSchema>;

export const decisionTimelineSchema = z.object({
  task: z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    deadline: z.string().nullable(),
    priority: z.string(),
    estimatedMinutes: z.number().int().nullable(),
    status: z.string(),
  }),
  /** 无来源（手动创建）时为 null，不伪造来源 */
  source: z
    .object({
      id: z.string(),
      title: z.string(),
      sourceType: z.string(),
      capturedAt: z.string(),
    })
    .nullable(),
  stages: z.array(decisionStageSchema),
});
export type DecisionTimeline = z.infer<typeof decisionTimelineSchema>;
