import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { AIConfigError, AIError, getAIProvider, type AIErrorCode } from "@/lib/ai";
import {
  DECOMPOSITION_MAX_SUBTASKS,
  DECOMPOSITION_MIN_SUBTASKS,
  confirmDecompositionPayloadSchema,
  decompositionResultSchema,
  sortProposedSubTasks,
  validateDecomposition,
  type AIMeta,
  type DecompositionResult,
  type ProposedSubTask,
} from "@/lib/ai/contract";

// ============================================================
// Tasks 业务服务（S3）
// 路由层只处理 HTTP 语义；查询、AI 拆解、依赖校验、事务写入
// 全部集中在这里，便于 verify 脚本绕过 HTTP 直接测试。
// ============================================================

export class TaskError extends Error {
  constructor(
    public readonly code:
      | "TASK_NOT_FOUND"
      | "ALREADY_DECOMPOSED"
      | "VALIDATION_FAILED"
      | "DECOMPOSITION_INVALID"
      | "PROVIDER_ERROR"
      | AIErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskError";
  }
}

const MAX_SOURCE_CONTEXT = 500;

export interface TaskListItem {
  id: string;
  title: string;
  description: string | null;
  deadline: string | null;
  priority: string;
  status: string;
  estimatedMinutes: number | null;
  sourceTitle: string | null;
  subtaskCount: number;
}

export interface SubTaskItem {
  id: string;
  title: string;
  estimatedMinutes: number | null;
  sortOrder: number;
  status: string;
  dependsOn: Array<{ id: string; title: string }>;
}

export interface TaskDetail extends TaskListItem {
  source: { id: string; title: string } | null;
  evidenceQuotes: string[];
  subTasks: SubTaskItem[];
}

/** 任务列表（按截止时间升序，无截止的排后） */
export async function listTasks(): Promise<TaskListItem[]> {
  const tasks = await prisma.task.findMany({
    orderBy: [{ deadline: "asc" }, { createdAt: "desc" }],
    include: {
      source: { select: { title: true } },
      _count: { select: { subTasks: true } },
    },
  });

  return tasks.map((task) => ({
    id: task.id,
    title: task.title,
    description: task.description,
    deadline: task.deadline ? task.deadline.toISOString() : null,
    priority: task.priority,
    status: task.status,
    estimatedMinutes: task.estimatedMinutes,
    sourceTitle: task.source?.title ?? null,
    subtaskCount: task._count.subTasks,
  }));
}

/** 从 S2 提取时落库的 DecisionLog 中取回原文依据（quote 列表） */
function parseEvidenceQuotes(evidence: string | null): string[] {
  if (!evidence) return [];
  try {
    const parsed = JSON.parse(evidence) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => (item as { quote?: unknown }).quote)
      .filter((quote): quote is string => typeof quote === "string" && quote.length > 0);
  } catch {
    return [];
  }
}

export async function getTaskDetail(taskId: string): Promise<TaskDetail> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      source: { select: { id: true, title: true } },
      subTasks: {
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        include: {
          dependencies: {
            include: { dependsOn: { select: { id: true, title: true } } },
          },
        },
      },
      decisionLogs: {
        where: { actionType: "EXTRACT" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { evidence: true },
      },
    },
  });

  if (!task) {
    throw new TaskError("TASK_NOT_FOUND", `任务不存在：${taskId}`);
  }

  return {
    id: task.id,
    title: task.title,
    description: task.description,
    deadline: task.deadline ? task.deadline.toISOString() : null,
    priority: task.priority,
    status: task.status,
    estimatedMinutes: task.estimatedMinutes,
    sourceTitle: task.source?.title ?? null,
    subtaskCount: task.subTasks.length,
    source: task.source,
    evidenceQuotes: parseEvidenceQuotes(task.decisionLogs[0]?.evidence ?? null),
    subTasks: task.subTasks.map((st) => ({
      id: st.id,
      title: st.title,
      estimatedMinutes: st.estimatedMinutes,
      sortOrder: st.sortOrder,
      status: st.status,
      dependsOn: st.dependencies.map((dep) => dep.dependsOn),
    })),
  };
}

export interface DecomposeOutput {
  provider: string;
  /** real 时为模型名，mock 为 null */
  model: string | null;
  promptVersion: string;
  durationMs: number;
  /** 供确认拆解时回传，写入 DecisionLog */
  aiMeta: AIMeta;
  taskSummary: string;
  subtasks: ProposedSubTask[];
}

/** 把 Provider / 配置错误翻译成带明确错误码的业务错误（不隐藏真实失败） */
function toProviderError(error: unknown): TaskError {
  if (error instanceof AIConfigError) {
    return new TaskError("AI_CONFIG_INVALID", error.message);
  }
  if (error instanceof AIError) {
    return new TaskError(error.code, `AI 调用失败（${error.code}）：${error.message}`);
  }
  return new TaskError("PROVIDER_ERROR", `AI Provider 调用失败：${(error as Error).message}`);
}

/**
 * AI 拆解预览：查询真实任务 → 调 Provider → Zod 校验 → 依赖图校验。
 * 不写数据库；已存在正式子任务时拒绝重复拆解。
 */
export async function decomposeTask(taskId: string): Promise<DecomposeOutput> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      source: { select: { title: true, rawText: true } },
      _count: { select: { subTasks: true } },
    },
  });
  if (!task) {
    throw new TaskError("TASK_NOT_FOUND", `任务不存在：${taskId}`);
  }
  if (task._count.subTasks > 0) {
    throw new TaskError(
      "ALREADY_DECOMPOSED",
      "该任务已拆解，S3 不覆盖已有子任务；如需调整请直接编辑现有子任务",
    );
  }

  let provider;
  try {
    provider = getAIProvider();
  } catch (error) {
    throw toProviderError(error);
  }

  const sourceContext = task.source
    ? `${task.source.title}\n${task.source.rawText.slice(0, MAX_SOURCE_CONTEXT)}`
    : undefined;

  let rawOutput: unknown;
  const startedAt = Date.now();
  try {
    rawOutput = await provider.decomposeTask({
      taskId: task.id,
      title: task.title,
      description: task.description,
      deadline: task.deadline ? task.deadline.toISOString() : null,
      estimatedMinutes: task.estimatedMinutes,
      sourceContext,
    });
  } catch (error) {
    throw toProviderError(error);
  }
  const durationMs = Date.now() - startedAt;

  const parsed = decompositionResultSchema.safeParse(rawOutput);
  if (!parsed.success) {
    throw new TaskError(
      "DECOMPOSITION_INVALID",
      `AI 拆解结果未通过契约校验：${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("；")}`,
    );
  }

  const problems = validateDecomposition(parsed.data);
  if (problems.length > 0) {
    throw new TaskError("DECOMPOSITION_INVALID", problems.join("；"));
  }

  const meta = provider.meta;
  const aiMeta: AIMeta = {
    provider: meta.provider,
    model: meta.model,
    promptVersion: meta.decompositionPromptVersion,
    durationMs,
  };

  return {
    provider: provider.name,
    model: meta.model,
    promptVersion: meta.decompositionPromptVersion,
    durationMs,
    aiMeta,
    taskSummary: parsed.data.taskSummary,
    subtasks: sortProposedSubTasks(parsed.data.subtasks),
  };
}

export interface ConfirmDecompositionOutput {
  taskId: string;
  subtaskIds: string[];
  dependencyCount: number;
  decisionLogId: string;
}

/**
 * 在给定事务中写入子任务、依赖与决策日志。
 * 单独导出以便验证脚本注入失败、确认整体回滚。
 */
export async function writeDecomposition(
  tx: Prisma.TransactionClient,
  task: { id: string; title: string; deadline: Date | null; estimatedMinutes: number | null },
  result: DecompositionResult,
  aiMeta?: AIMeta,
): Promise<{ subtaskIds: string[]; decisionLogId: string }> {
  const ordered = sortProposedSubTasks(result.subtasks);
  const idMap = new Map<string, string>();
  const subtaskIds: string[] = [];

  // 1) 先创建全部子任务，建立 clientId → databaseId 映射
  for (const subtask of ordered) {
    const created = await tx.subTask.create({
      data: {
        taskId: task.id,
        title: subtask.title,
        estimatedMinutes: subtask.estimatedMinutes,
        sortOrder: subtask.sortOrder,
        status: "TODO",
      },
    });
    idMap.set(subtask.clientId, created.id);
    subtaskIds.push(created.id);
  }

  // 2) 再根据 dependsOn 建立依赖（只使用映射出的真实 ID，禁止信任前端）
  const dependencies: Array<{ subTaskId: string; dependsOnId: string }> = [];
  for (const subtask of ordered) {
    for (const depClientId of subtask.dependsOn) {
      const subTaskId = idMap.get(subtask.clientId);
      const dependsOnId = idMap.get(depClientId);
      if (!subTaskId || !dependsOnId) {
        throw new TaskError(
          "DECOMPOSITION_INVALID",
          `依赖引用无法映射到数据库 ID：${subtask.clientId} → ${depClientId}`,
        );
      }
      await tx.subTaskDependency.create({ data: { subTaskId, dependsOnId } });
      dependencies.push({ subTaskId, dependsOnId });
    }
  }

  // 3) 决策留痕：输入任务摘要 / 输出子任务摘要 / 依赖摘要
  //    只记录 provider / model / prompt 版本 / 耗时，不含任何密钥或完整 Prompt
  const metaParts: string[] = [];
  if (aiMeta) {
    metaParts.push(`AI provider=${aiMeta.provider}`);
    if (aiMeta.model) metaParts.push(`model=${aiMeta.model}`);
    metaParts.push(`promptVersion=${aiMeta.promptVersion}`);
    if (typeof aiMeta.durationMs === "number") metaParts.push(`耗时 ${aiMeta.durationMs}ms`);
  }
  const metaSuffix = metaParts.length > 0 ? `；${metaParts.join("；")}` : "";
  const inputSummary = `任务「${task.title}」，截止 ${
    task.deadline ? task.deadline.toISOString() : "未设置"
  }，预计 ${task.estimatedMinutes ?? "未设置"} 分钟${metaSuffix}`;
  const outputSummary = ordered
    .map(
      (s, i) =>
        `${i + 1}. ${s.title}（${s.estimatedMinutes} 分钟${
          s.dependsOn.length > 0 ? `，依赖 ${s.dependsOn.join(", ")}` : ""
        }）`,
    )
    .join("；");
  const evidence = JSON.stringify({
    subtasks: ordered.map((s) => ({
      clientId: s.clientId,
      title: s.title,
      estimatedMinutes: s.estimatedMinutes,
      sortOrder: s.sortOrder,
      dependsOn: s.dependsOn,
    })),
    dependencies,
  });

  const decisionLog = await tx.decisionLog.create({
    data: {
      actionType: "DECOMPOSE",
      inputSummary,
      outputSummary: `拆解为 ${ordered.length} 个子任务：${outputSummary}`,
      evidence,
      relatedTaskId: task.id,
    },
  });

  return { subtaskIds, decisionLogId: decisionLog.id };
}

/**
 * 确认拆解：任务 ID 以 URL/数据库为准，前端提交的依赖关系必须重新校验，
 * 写入过程在单个事务中完成，任一步失败整体回滚。
 */
export async function confirmDecomposition(
  taskId: string,
  payload: unknown,
): Promise<ConfirmDecompositionOutput> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      title: true,
      deadline: true,
      estimatedMinutes: true,
      _count: { select: { subTasks: true } },
    },
  });
  if (!task) {
    throw new TaskError("TASK_NOT_FOUND", `任务不存在：${taskId}`);
  }
  if (task._count.subTasks > 0) {
    throw new TaskError("ALREADY_DECOMPOSED", "该任务已拆解，禁止重复确认覆盖");
  }

  const parsed = confirmDecompositionPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new TaskError(
      "VALIDATION_FAILED",
      `提交数据未通过校验：${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("；")}`,
    );
  }

  const count = parsed.data.subtasks.length;
  if (count < DECOMPOSITION_MIN_SUBTASKS || count > DECOMPOSITION_MAX_SUBTASKS) {
    throw new TaskError(
      "VALIDATION_FAILED",
      `子任务数量必须在 ${DECOMPOSITION_MIN_SUBTASKS}~${DECOMPOSITION_MAX_SUBTASKS} 之间`,
    );
  }

  const result: DecompositionResult = {
    taskSummary: "（人工确认）",
    subtasks: parsed.data.subtasks,
  };
  const problems = validateDecomposition(result);
  if (problems.length > 0) {
    throw new TaskError("DECOMPOSITION_INVALID", problems.join("；"));
  }

  const written = await prisma.$transaction(async (tx) => {
    return writeDecomposition(tx, task, result, parsed.data.aiMeta);
  });

  const dependencyCount = result.subtasks.reduce((sum, s) => sum + s.dependsOn.length, 0);
  return {
    taskId: task.id,
    subtaskIds: written.subtaskIds,
    dependencyCount,
    decisionLogId: written.decisionLogId,
  };
}
