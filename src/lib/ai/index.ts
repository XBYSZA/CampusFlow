import { loadRealLLMConfig, resolveAIProviderKind } from "./config";
import { MockAIProvider } from "./mock-provider";
import { RealAIProvider } from "./real-provider";
import type { AIProvider } from "./provider";

// ============================================================
// AIProvider 工厂（S2 建立，S6 接入真实 Provider）
// AI_PROVIDER 未设置 / 空串 → MockAIProvider
// AI_PROVIDER=mock        → MockAIProvider
// AI_PROVIDER=real        → RealAIProvider（配置缺失时抛 AI_CONFIG_INVALID）
// 其他取值                → AI_CONFIG_INVALID
//
// 明确不做缓存，也不做 fallback：每次调用都按当前环境变量解析，
// 既避免「配置改了但进程还用旧实例」，也避免「real 失败后偷偷用 mock」。
// ============================================================

export function getAIProvider(): AIProvider {
  const kind = resolveAIProviderKind();
  if (kind === "mock") return new MockAIProvider();
  return new RealAIProvider(loadRealLLMConfig());
}

export type { AIProvider, AIProviderMeta, DecomposeTaskInput, ExtractTasksInput } from "./provider";
export { AIConfigError, loadRealLLMConfig, resolveAIProviderKind } from "./config";
export { AIError, type AIErrorCode } from "./errors";
