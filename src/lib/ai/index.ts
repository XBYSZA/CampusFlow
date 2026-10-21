import { MockAIProvider } from "./mock-provider";
import type { AIProvider } from "./provider";

// ============================================================
// AIProvider 工厂（S2）
// 通过环境变量 AI_PROVIDER 切换实现：
//   AI_PROVIDER=mock（默认）→ MockAIProvider
//   AI_PROVIDER=real        → RealAIProvider（后续阶段实现）
// ============================================================

let cachedProvider: AIProvider | null = null;

export function getAIProvider(): AIProvider {
  if (cachedProvider) return cachedProvider;

  const kind = (process.env.AI_PROVIDER ?? "mock").trim().toLowerCase();
  switch (kind) {
    case "mock":
      cachedProvider = new MockAIProvider();
      break;
    case "real":
      // S2 阶段不实现真实 Provider；后续阶段在此注册 RealAIProvider
      throw new Error(
        "RealAIProvider 尚未实现：当前阶段请使用 AI_PROVIDER=mock",
      );
    default:
      throw new Error(`未知的 AI_PROVIDER 取值：「${kind}」（可选：mock）`);
  }
  return cachedProvider;
}

export type { AIProvider, ExtractTasksInput } from "./provider";
