// ============================================================
// RealAIProvider（S6）
// OpenAI-compatible HTTP Provider，用原生 fetch 实现，不引入厂商 SDK。
//
// 职责边界：
// - 只负责 extractTasks / decomposeTask（信息理解与任务拆解）
// - 不参与排期、冲突检测、重排时间决策
// - 不直接操作数据库
//
// 数据流（extract）：
// rawText → Prompt → 模型纯 JSON（EvidenceCandidate：只有 quote）
//        → 服务端在 rawText 中定位 quote → 计算 start/end
//        → 正式 ExtractionResult → 复用 S2 的 evidence 校验
// ============================================================

import { z } from "zod";
import { loadRealLLMConfig, type RealLLMConfig } from "./config";
import {
  CONTRACT_PRIORITIES,
  ESTIMATED_MINUTES_MAX,
  ESTIMATED_MINUTES_MIN,
  decompositionResultSchema,
  extractionResultSchema,
  validateExtractionEvidences,
  type DecompositionResult,
  type Evidence,
  type ExtractedTask,
  type ExtractionResult,
} from "./contract";
import { AIError } from "./errors";
import {
  DECOMPOSITION_PROMPT_VERSION,
  EXTRACTION_PROMPT_VERSION,
  buildDecompositionMessages,
  buildExtractionMessages,
  type ChatMessage,
} from "./prompts";
import type { AIProvider, AIProviderMeta, DecomposeTaskInput, ExtractTasksInput } from "./provider";

/** 网络错误 / 5xx 允许自动重试的次数（总尝试次数 = 1 + RETRY_LIMIT） */
const RETRY_LIMIT = 1;

// ---------- 模型输出的 candidate 契约 ----------
// 模型只允许返回 quote，start/end 由服务端计算，不信任模型自报的字符偏移。
const candidateEvidenceSchema = z.object({
  quote: z.string().min(1).max(500),
});

const candidateTaskSchema = z.object({
  title: z.string().min(1).max(100),
  description: z.string().max(500).nullish(),
  deadline: z.iso.datetime({ offset: true }).nullish(),
  priority: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
    z.enum(CONTRACT_PRIORITIES),
  ),
  estimatedMinutes: z.coerce
    .number()
    .int()
    .min(ESTIMATED_MINUTES_MIN)
    .max(ESTIMATED_MINUTES_MAX),
  evidence: z.array(candidateEvidenceSchema).max(10),
});

const extractionCandidateSchema = z.object({
  eventTitle: z.string().min(1).max(120),
  summary: z.string().max(500),
  tasks: z.array(candidateTaskSchema).max(20),
});

const chatCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
        }),
      }),
    )
    .min(1),
});

function truncate(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 去掉模型可能包裹的最外层 Markdown 代码块。
 * 只处理 ```json ... ``` / ``` ... ``` 这一种情况，不做任何「猜 JSON」的复杂解析。
 */
export function stripOutermostCodeFence(content: string): string {
  const text = content.trim();
  if (!text.startsWith("```")) return text;
  const match = text.match(/^```[A-Za-z0-9_-]*\s*\n?([\s\S]*?)\n?```$/);
  return match ? match[1].trim() : text;
}

/** 有限清理 → JSON.parse；不是合法 JSON 时抛 AI_RESPONSE_INVALID */
export function parseModelJson(content: string): unknown {
  const cleaned = stripOutermostCodeFence(content);
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new AIError("AI_RESPONSE_INVALID", "真实 AI 返回内容不是合法 JSON（已尝试清理最外层代码块）");
  }
}

/**
 * 在原文中定位 quote 并计算真实 start/end。
 * 确定性策略：quote 必须唯一出现；出现 0 次 → EVIDENCE_NOT_FOUND，
 * 出现多次 → EVIDENCE_AMBIGUOUS（拒绝该 evidence，不猜位置）。
 */
export function resolveEvidenceQuote(rawText: string, quote: string): Evidence {
  const first = rawText.indexOf(quote);
  if (first < 0) {
    throw new AIError(
      "EVIDENCE_NOT_FOUND",
      `evidence 引用的原文片段不存在：「${truncate(quote)}」`,
    );
  }
  const second = rawText.indexOf(quote, first + 1);
  if (second >= 0) {
    throw new AIError(
      "EVIDENCE_AMBIGUOUS",
      `evidence 引用的原文片段在原文中出现多次，无法唯一定位：「${truncate(quote)}」`,
    );
  }
  return { quote, start: first, end: first + quote.length };
}

/**
 * 拆解 candidate 的最小归一化：模型常把可选字段写成 null。
 * 只做 null → 缺省 / 空数组的等价转换，不做任何猜测性修补。
 */
function normalizeDecompositionCandidate(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.subtasks)) return value;
  return {
    ...record,
    subtasks: record.subtasks.map((item) => {
      if (!item || typeof item !== "object") return item;
      const sub = { ...(item as Record<string, unknown>) };
      if (sub.description === null) delete sub.description;
      if (sub.dependsOn === null) sub.dependsOn = [];
      return sub;
    }),
  };
}

function logFailure(
  config: RealLLMConfig,
  info: { status?: number; durationMs: number; code: string; detail?: string },
): void {
  // 仅记录可诊断信息；绝不记录 API Key / Authorization / 完整请求头
  console.warn(
    `[ai] provider=real model=${config.model} status=${info.status ?? "-"} ` +
      `durationMs=${info.durationMs} error=${info.code}${info.detail ? ` ${info.detail}` : ""}`,
  );
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (error as { name?: string } | null)?.name === "AbortError";
}

export class RealAIProvider implements AIProvider {
  readonly name = "real";
  readonly meta: AIProviderMeta;
  private readonly config: RealLLMConfig;

  constructor(config: RealLLMConfig = loadRealLLMConfig()) {
    this.config = config;
    this.meta = {
      provider: "real",
      model: config.model,
      extractionPromptVersion: EXTRACTION_PROMPT_VERSION,
      decompositionPromptVersion: DECOMPOSITION_PROMPT_VERSION,
    };
  }

  // ------------------------------------------------------------
  // HTTP：单次调用 + 超时 + 有限重试
  // ------------------------------------------------------------
  private async requestCompletion(messages: ChatMessage[]): Promise<string> {
    const { config } = this;
    let lastError: AIError | null = null;

    for (let attempt = 0; attempt <= RETRY_LIMIT; attempt += 1) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);

      try {
        const response = await globalThis.fetch(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages,
            temperature: 0,
          }),
          signal: controller.signal,
        });
        const durationMs = Date.now() - startedAt;
        const status = response.status;

        if (!response.ok) {
          if (status >= 500) {
            lastError = new AIError(
              "AI_REQUEST_FAILED",
              `真实 AI 服务返回 HTTP ${status}，重试后仍失败`,
              status,
            );
            logFailure(config, { status, durationMs, code: "AI_REQUEST_FAILED" });
            if (attempt < RETRY_LIMIT) continue;
            throw lastError;
          }
          if (status === 401 || status === 403) {
            logFailure(config, { status, durationMs, code: "AI_REQUEST_FAILED" });
            throw new AIError(
              "AI_REQUEST_FAILED",
              `真实 AI 服务认证失败（HTTP ${status}），请检查 REAL_LLM_API_KEY 是否有权限`,
              status,
            );
          }
          logFailure(config, { status, durationMs, code: "AI_REQUEST_FAILED" });
          throw new AIError(
            "AI_REQUEST_FAILED",
            `真实 AI 服务返回 HTTP ${status}（该状态码不自动重试）`,
            status,
          );
        }

        const payload = (await response.json().catch(() => null)) as unknown;
        const parsed = chatCompletionSchema.safeParse(payload);
        const content = parsed.success ? parsed.data.choices[0]?.message?.content?.trim() : "";
        if (!content) {
          logFailure(config, { status, durationMs, code: "AI_RESPONSE_INVALID" });
          throw new AIError("AI_RESPONSE_INVALID", "真实 AI 响应缺少 choices[0].message.content");
        }
        return content;
      } catch (error) {
        if (error instanceof AIError) throw error;
        if (isAbortError(error)) {
          logFailure(config, {
            durationMs: Date.now() - startedAt,
            code: "AI_TIMEOUT",
          });
          throw new AIError("AI_TIMEOUT", `真实 AI 请求超时（${config.timeoutMs}ms）`);
        }
        lastError = new AIError(
          "AI_REQUEST_FAILED",
          `真实 AI 网络请求失败：${(error as Error).message}`,
        );
        logFailure(config, {
          durationMs: Date.now() - startedAt,
          code: "AI_REQUEST_FAILED",
          detail: `attempt=${attempt + 1}`,
        });
        if (attempt < RETRY_LIMIT) continue;
        throw lastError;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new AIError("AI_REQUEST_FAILED", "真实 AI 请求失败");
  }

  // ------------------------------------------------------------
  // extractTasks
  // ------------------------------------------------------------
  async extractTasks(input: ExtractTasksInput): Promise<ExtractionResult> {
    const content = await this.requestCompletion(buildExtractionMessages(input));
    const json = parseModelJson(content);

    const candidate = extractionCandidateSchema.safeParse(json);
    if (!candidate.success) {
      throw new AIError(
        "AI_SCHEMA_INVALID",
        `真实 AI 提取结果不符合候选结构：${candidate.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("；")}`,
      );
    }

    // quote → 真实 start/end（服务端计算，不信任模型自报位置）
    const tasks: ExtractedTask[] = candidate.data.tasks.map((task) => ({
      title: task.title,
      description: task.description ?? undefined,
      deadline: task.deadline ?? null,
      priority: task.priority,
      estimatedMinutes: task.estimatedMinutes,
      evidence: task.evidence.map((item) => resolveEvidenceQuote(input.rawText, item.quote)),
    }));

    const result: ExtractionResult = {
      eventTitle: candidate.data.eventTitle,
      summary: candidate.data.summary,
      tasks,
    };

    // 正式契约校验（与 Mock 共用同一套 schema）
    const parsed = extractionResultSchema.safeParse(result);
    if (!parsed.success) {
      throw new AIError(
        "AI_SCHEMA_INVALID",
        `真实 AI 提取结果未通过提取契约：${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("；")}`,
      );
    }

    const problems = validateExtractionEvidences(input.rawText, parsed.data.tasks);
    if (problems.length > 0) {
      throw new AIError("AI_SCHEMA_INVALID", `真实 AI evidence 校验失败：${problems.join("；")}`);
    }

    return parsed.data;
  }

  // ------------------------------------------------------------
  // decomposeTask
  // ------------------------------------------------------------
  async decomposeTask(input: DecomposeTaskInput): Promise<DecompositionResult> {
    const content = await this.requestCompletion(buildDecompositionMessages(input));
    const json = normalizeDecompositionCandidate(parseModelJson(content));

    // 依赖图的最终裁决仍由服务端 validateDecomposition 执行
    const parsed = decompositionResultSchema.safeParse(json);
    if (!parsed.success) {
      throw new AIError(
        "AI_SCHEMA_INVALID",
        `真实 AI 拆解结果不符合契约：${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("；")}`,
      );
    }
    return parsed.data;
  }
}
