// ============================================================
// AI Provider 配置（S6）
// 只从服务端环境变量读取；不导出给浏览器，也不使用 NEXT_PUBLIC_ 前缀。
// AI_PROVIDER=mock 时不要求任何 REAL_LLM_* 变量。
// AI_PROVIDER=real 时三项必需配置缺一不可，禁止静默回退 Mock。
// ============================================================

import { AIError } from "./errors";

export type AIProviderKind = "mock" | "real";

export const DEFAULT_REAL_LLM_TIMEOUT_MS = 30000;

/** 配置类错误：统一错误码 AI_CONFIG_INVALID，并带上缺失变量名 */
export class AIConfigError extends AIError {
  constructor(
    message: string,
    public readonly missing: string[] = [],
  ) {
    super("AI_CONFIG_INVALID", message);
    this.name = "AIConfigError";
  }
}

export interface RealLLMConfig {
  /** 已去掉末尾斜杠的 base URL，例如 https://api.example.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/** 解析 AI_PROVIDER：未设置或空串 → mock；其他非法值直接拒绝 */
export function resolveAIProviderKind(env: NodeJS.ProcessEnv = process.env): AIProviderKind {
  const raw = (env.AI_PROVIDER ?? "").trim();
  if (!raw) return "mock";
  const kind = raw.toLowerCase();
  if (kind === "mock" || kind === "real") return kind;
  throw new AIConfigError(`未知的 AI_PROVIDER 取值：「${raw}」（可选：mock | real）`);
}

function resolveTimeoutMs(raw: string | undefined): number {
  const parsed = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REAL_LLM_TIMEOUT_MS;
  return parsed;
}

/**
 * 读取并校验 Real Provider 配置。
 * 缺失必需项时抛 AIConfigError，绝不返回半成品配置，
 * 避免出现「以为在用真模型，其实悄悄用了 Mock」。
 */
export function loadRealLLMConfig(env: NodeJS.ProcessEnv = process.env): RealLLMConfig {
  const baseUrl = (env.REAL_LLM_BASE_URL ?? "").trim();
  const apiKey = (env.REAL_LLM_API_KEY ?? "").trim();
  const model = (env.REAL_LLM_MODEL ?? "").trim();

  const missing: string[] = [];
  if (!baseUrl) missing.push("REAL_LLM_BASE_URL");
  if (!apiKey) missing.push("REAL_LLM_API_KEY");
  if (!model) missing.push("REAL_LLM_MODEL");
  if (missing.length > 0) {
    throw new AIConfigError(
      `AI_PROVIDER=real 缺少必需配置：${missing.join("、")}（不会自动回退 Mock）`,
      missing,
    );
  }

  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new AIConfigError("REAL_LLM_BASE_URL 必须以 http:// 或 https:// 开头");
  }

  return {
    // 统一去掉末尾斜杠，拼接 /chat/completions 时不会出现双斜杠
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    model,
    timeoutMs: resolveTimeoutMs(env.REAL_LLM_TIMEOUT_MS),
  };
}
