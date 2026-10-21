import { z } from "zod";

// ============================================================
// AI 提取契约（S2）
// 所有 AI Provider（Mock / 未来 Real）的输出与 confirm 入参
// 都必须通过这里的 schema 与校验函数，校验逻辑集中管理，
// 不散落在 React 组件中。
// ============================================================

export const CONTRACT_PRIORITIES = ["low", "medium", "high"] as const;
export type ContractPriority = (typeof CONTRACT_PRIORITIES)[number];

// 预计耗时上下限（分钟）：15 分钟 ~ 8 小时
export const ESTIMATED_MINUTES_MIN = 15;
export const ESTIMATED_MINUTES_MAX = 480;

// ---------- Evidence：原文依据 ----------
// 硬性要求：
// 1. quote 必须是 rawText 中真实存在的连续子串
// 2. rawText.slice(start, end) 必须严格等于 quote
// 3. start/end 越界视为无效
export const evidenceSchema = z
  .object({
    quote: z.string().min(1).max(500),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .refine((e) => e.end > e.start, { message: "evidence.end 必须大于 evidence.start" });

export type Evidence = z.infer<typeof evidenceSchema>;

// ---------- AI 输出契约 ----------
export const extractedTaskSchema = z.object({
  title: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  // 截止无法确定时允许 null，Provider 禁止猜测
  // offset: true —— 允许带时区偏移的 ISO 时间（如 +08:00），不限于 UTC Z 后缀
  deadline: z.iso.datetime({ offset: true }).nullable(),
  priority: z.enum(CONTRACT_PRIORITIES),
  estimatedMinutes: z
    .number()
    .int()
    .min(ESTIMATED_MINUTES_MIN)
    .max(ESTIMATED_MINUTES_MAX),
  evidence: z.array(evidenceSchema).max(10),
});

export type ExtractedTask = z.infer<typeof extractedTaskSchema>;

export const extractionResultSchema = z.object({
  eventTitle: z.string().min(1).max(120),
  summary: z.string().max(500),
  tasks: z.array(extractedTaskSchema).max(20),
});

export type ExtractionResult = z.infer<typeof extractionResultSchema>;

// ---------- confirm 入参契约（用户编辑后的结果） ----------
export const confirmedTaskSchema = z.object({
  title: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  // 允许任意可解析日期字符串（来自 <input type="datetime-local">），服务端统一转 Date
  deadline: z
    .string()
    .nullable()
    .refine((v) => v === null || !Number.isNaN(Date.parse(v)), {
      message: "deadline 不是可解析的日期时间",
    }),
  priority: z.enum(CONTRACT_PRIORITIES),
  estimatedMinutes: z
    .number()
    .int()
    .min(ESTIMATED_MINUTES_MIN)
    .max(ESTIMATED_MINUTES_MAX),
  evidence: z.array(evidenceSchema).max(10),
});

export type ConfirmedTask = z.infer<typeof confirmedTaskSchema>;

export const confirmPayloadSchema = z.object({
  sourceTitle: z.string().min(1).max(120),
  rawText: z.string().min(1).max(20000),
  eventTitle: z.string().min(1).max(120),
  tasks: z.array(confirmedTaskSchema).min(1).max(20),
  // 客户端一次性提交标识，仅用于 DecisionLog 追溯，不作为幂等键
  submissionId: z.string().min(8).max(64).optional(),
});

export type ConfirmPayload = z.infer<typeof confirmPayloadSchema>;

// ---------- evidence 精确校验（服务端必须执行，不信任前端） ----------

/** 校验单条 evidence 与原文的一致性，返回 null 表示通过，否则返回原因 */
export function validateEvidenceAgainstRawText(
  rawText: string,
  evidence: Evidence,
): string | null {
  const { quote, start, end } = evidence;
  if (start < 0 || end > rawText.length || end <= start) {
    return `evidence 越界：start=${start}, end=${end}, rawText.length=${rawText.length}`;
  }
  if (rawText.slice(start, end) !== quote) {
    return "rawText.slice(start, end) 与 quote 不一致";
  }
  if (!rawText.includes(quote)) {
    return "quote 不是原文中的连续子串";
  }
  return null;
}

/** 校验整个提取结果的 evidence 合法性，返回问题列表（空数组 = 全部通过） */
export function validateExtractionEvidences(
  rawText: string,
  tasks: Array<Pick<ExtractedTask, "title" | "evidence">>,
): string[] {
  const problems: string[] = [];
  for (const task of tasks) {
    for (const ev of task.evidence) {
      const problem = validateEvidenceAgainstRawText(rawText, ev);
      if (problem) {
        problems.push(`任务「${task.title}」：${problem}`);
      }
    }
  }
  return problems;
}

// ---------- 契约层（lowercase）与领域层（DB uppercase）优先级映射 ----------
export function priorityToDomain(priority: ContractPriority): "LOW" | "MEDIUM" | "HIGH" {
  return priority.toUpperCase() as "LOW" | "MEDIUM" | "HIGH";
}

export function priorityFromDomain(priority: string): ContractPriority {
  const lower = priority.toLowerCase();
  if (lower === "low" || lower === "medium" || lower === "high") return lower;
  return "medium";
}
