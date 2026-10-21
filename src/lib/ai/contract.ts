import { z } from "zod";
import { findDependencyCycle } from "@/lib/domain";

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

// ============================================================
// AI 任务拆解契约（S3）
// 延续 S2 原则：AI 只提出建议，人工确认后才写入正式数据。
// ============================================================

export const DECOMPOSITION_MIN_SUBTASKS = 2;
export const DECOMPOSITION_MAX_SUBTASKS = 8;

// clientId：拆解结果内部的临时标识，必须唯一，不使用数据库 ID
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export const proposedSubTaskSchema = z.object({
  clientId: z
    .string()
    .regex(CLIENT_ID_RE, "clientId 只能包含字母、数字、下划线或连字符，长度 1~40"),
  title: z.string().trim().min(1, "子任务标题不能为空").max(100),
  description: z.string().max(500).optional(),
  estimatedMinutes: z
    .number()
    .int()
    .min(ESTIMATED_MINUTES_MIN)
    .max(ESTIMATED_MINUTES_MAX),
  sortOrder: z.number().int().min(0).max(99),
  // dependsOn 只能引用同一次拆解结果里存在的 clientId
  dependsOn: z.array(z.string().regex(CLIENT_ID_RE)).max(DECOMPOSITION_MAX_SUBTASKS),
});

export type ProposedSubTask = z.infer<typeof proposedSubTaskSchema>;

export const decompositionResultSchema = z.object({
  taskSummary: z.string().min(1).max(500),
  subtasks: z
    .array(proposedSubTaskSchema)
    .min(DECOMPOSITION_MIN_SUBTASKS)
    .max(DECOMPOSITION_MAX_SUBTASKS),
});

export type DecompositionResult = z.infer<typeof decompositionResultSchema>;

// confirm-decomposition 入参：只提交用户编辑后的子任务列表
export const confirmDecompositionPayloadSchema = z.object({
  subtasks: z
    .array(proposedSubTaskSchema)
    .min(DECOMPOSITION_MIN_SUBTASKS)
    .max(DECOMPOSITION_MAX_SUBTASKS),
});

export type ConfirmDecompositionPayload = z.infer<typeof confirmDecompositionPayloadSchema>;

/**
 * 拆解结果的依赖图校验（服务端最终裁决，前端提示不算数）。
 * 覆盖：clientId 唯一 / dependsOn 必须存在 / 禁止自依赖 / 禁止环（复用 S1 findDependencyCycle）。
 * 返回问题列表，空数组表示通过。
 */
export function validateDecomposition(result: DecompositionResult): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();

  for (const st of result.subtasks) {
    if (ids.has(st.clientId)) {
      problems.push(`clientId 重复：${st.clientId}`);
    }
    ids.add(st.clientId);
  }

  // sortOrder 必须唯一，保证展示顺序稳定
  const seenOrders = new Set<number>();
  for (const st of result.subtasks) {
    if (seenOrders.has(st.sortOrder)) {
      problems.push(`sortOrder 重复：${st.sortOrder}`);
    }
    seenOrders.add(st.sortOrder);
  }

  for (const st of result.subtasks) {
    for (const dep of st.dependsOn) {
      if (dep === st.clientId) {
        problems.push(`子任务「${st.title}」不能依赖自己`);
      } else if (!ids.has(dep)) {
        problems.push(`子任务「${st.title}」依赖了不存在的 clientId：${dep}`);
      }
    }
  }

  // 环检测：只把合法的引用交给 S1 的通用算法，避免两套冲突逻辑
  const edges = result.subtasks.flatMap((st) =>
    st.dependsOn.filter((dep) => ids.has(dep) && dep !== st.clientId).map((dep) => ({
      subTaskId: st.clientId,
      dependsOnId: dep,
    })),
  );
  const cycle = findDependencyCycle(edges);
  if (cycle) {
    problems.push(`依赖关系存在环：${cycle.subTaskId} → ${cycle.dependsOnId}`);
  }

  return problems;
}

/** 按 sortOrder 升序返回子任务（不改变原数组），保证顺序稳定 */
export function sortProposedSubTasks(subtasks: ProposedSubTask[]): ProposedSubTask[] {
  return [...subtasks].sort((a, b) => a.sortOrder - b.sortOrder || a.clientId.localeCompare(b.clientId));
}
