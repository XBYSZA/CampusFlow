import { prisma } from "@/lib/prisma";
import { getAIProvider } from "@/lib/ai";
import {
  confirmPayloadSchema,
  extractionResultSchema,
  priorityToDomain,
  validateExtractionEvidences,
  type ConfirmPayload,
  type ExtractionResult,
} from "@/lib/ai/contract";

// ============================================================
// Inbox 业务服务层（S2）
// 路由层只负责 HTTP 语义，业务规则全部集中在这里，
// 便于 verify 脚本绕过 HTTP 直接测试。
// ============================================================

export class InboxError extends Error {
  constructor(
    public readonly code:
      | "EMPTY_INPUT"
      | "AI_OUTPUT_INVALID"
      | "EVIDENCE_INVALID"
      | "VALIDATION_FAILED"
      | "DUPLICATE_SOURCE"
      | "PROVIDER_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "InboxError";
  }
}

export interface ExtractInboxInput {
  rawText?: string;
  sourceTitle?: string;
}

export interface ExtractInboxOutput extends ExtractionResult {
  provider: string;
}

/** 提取：调 AIProvider → Zod 校验 → evidence 精确匹配校验。不写数据库。 */
export async function extractInbox(input: ExtractInboxInput): Promise<ExtractInboxOutput> {
  const rawText = input.rawText ?? "";
  if (!rawText.trim()) {
    throw new InboxError("EMPTY_INPUT", "通知原文为空，请先粘贴或加载演示通知");
  }

  let provider;
  try {
    provider = getAIProvider();
  } catch (error) {
    throw new InboxError("PROVIDER_ERROR", (error as Error).message);
  }

  let rawOutput: unknown;
  try {
    rawOutput = await provider.extractTasks({ rawText, sourceTitle: input.sourceTitle });
  } catch (error) {
    throw new InboxError("PROVIDER_ERROR", `AI Provider 调用失败：${(error as Error).message}`);
  }

  const parsed = extractionResultSchema.safeParse(rawOutput);
  if (!parsed.success) {
    throw new InboxError(
      "AI_OUTPUT_INVALID",
      `AI 输出未通过契约校验：${parsed.error.issues.map((i) => i.message).join("；")}`,
    );
  }

  // evidence 必须能在原文中精确命中（不信任 Provider 自报的位置）
  const problems = validateExtractionEvidences(rawText, parsed.data.tasks);
  if (problems.length > 0) {
    throw new InboxError("EVIDENCE_INVALID", problems.join("；"));
  }

  return { provider: provider.name, ...parsed.data };
}

export interface ConfirmInboxOutput {
  sourceId: string;
  taskIds: string[];
  decisionLogIds: string[];
  taskCount: number;
}

/**
 * 确认入库：服务端再次完整校验 → Prisma 事务写入
 * Source + Task[] + DecisionLog[]（每任务一条，携带该任务的 evidence）。
 */
export async function confirmInbox(payload: unknown): Promise<ConfirmInboxOutput> {
  const parsed = confirmPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new InboxError(
      "VALIDATION_FAILED",
      `提交数据未通过校验：${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；")}`,
    );
  }
  const data: ConfirmPayload = parsed.data;

  // 服务端复核 evidence：禁止信任前端直接传来的 quote/start/end
  const problems = validateExtractionEvidences(data.rawText, data.tasks);
  if (problems.length > 0) {
    throw new InboxError("EVIDENCE_INVALID", problems.join("；"));
  }

  // 重复提交防护：相同原文的通知已入库过则拒绝（配合前端按钮禁用）
  const existing = await prisma.source.findFirst({
    where: { rawText: data.rawText },
    select: { id: true, title: true },
  });
  if (existing) {
    throw new InboxError(
      "DUPLICATE_SOURCE",
      `相同原文的通知已入库（${existing.title}），请勿重复提交`,
    );
  }

  const inputSummary = `收件箱提取：《${data.sourceTitle}》原文 ${data.rawText.length} 字`;

  const result = await prisma.$transaction(async (tx) => {
    const source = await tx.source.create({
      data: {
        title: data.sourceTitle,
        rawText: data.rawText,
        sourceType: "NOTICE",
      },
    });

    const taskIds: string[] = [];
    const decisionLogIds: string[] = [];

    for (const task of data.tasks) {
      const createdTask = await tx.task.create({
        data: {
          sourceId: source.id,
          title: task.title,
          description: task.description ?? null,
          deadline: task.deadline ? new Date(Date.parse(task.deadline)) : null,
          priority: priorityToDomain(task.priority),
          estimatedMinutes: task.estimatedMinutes,
          status: "TODO",
        },
      });
      taskIds.push(createdTask.id);

      const decisionLog = await tx.decisionLog.create({
        data: {
          actionType: "EXTRACT",
          inputSummary,
          outputSummary: `识别事件：${data.eventTitle}；任务：${task.title}${
            task.deadline ? `（截止 ${task.deadline}）` : "（无明确截止）"
          }`,
          evidence: JSON.stringify(task.evidence),
          relatedTaskId: createdTask.id,
        },
      });
      decisionLogIds.push(decisionLog.id);
    }

    return { sourceId: source.id, taskIds, decisionLogIds };
  });

  return { ...result, taskCount: data.tasks.length };
}
