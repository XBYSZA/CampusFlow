// ============================================================
// S6 可选冒烟脚本：真实调用一次 extract + 一次 decompose
//
// 使用前提：在 .env 中配置 AI_PROVIDER=real 与 REAL_LLM_*，然后手动执行
//   npm run s6:smoke
//
// 安全约束：
// - 未配置真实 Provider 时直接 SKIPPED，不报错，不影响 build / verify
// - 不写数据库
// - 不打印 API Key / Base URL / 完整请求头
// ============================================================

import "dotenv/config";
import { loadRealLLMConfig, resolveAIProviderKind } from "../src/lib/ai/config";
import { AIConfigError } from "../src/lib/ai/config";
import { RealAIProvider } from "../src/lib/ai/real-provider";
import type { RealLLMConfig } from "../src/lib/ai/config";

const SMOKE_TEXT = "请于10月28日18:00前提交报名表，并参加10月30日的开营仪式。";

async function main(): Promise<void> {
  let kind: "mock" | "real";
  try {
    kind = resolveAIProviderKind();
  } catch (error) {
    console.log(`SKIPPED: AI_PROVIDER 配置无效（${(error as Error).message}）`);
    return;
  }
  if (kind !== "real") {
    console.log("SKIPPED: 未配置 AI_PROVIDER=real，冒烟测试不执行（开发模式请使用 s6:verify）");
    return;
  }

  let config: RealLLMConfig;
  try {
    config = loadRealLLMConfig();
  } catch (error) {
    const missing = error instanceof AIConfigError ? error.missing.join("、") : "未知配置项";
    console.log(`SKIPPED: 缺少真实模型配置（${missing}）`);
    return;
  }

  console.log(`Running smoke: model=${config.model} timeoutMs=${config.timeoutMs}（不输出 API Key / Base URL）`);
  const provider = new RealAIProvider(config);

  const extractStarted = Date.now();
  const extraction = await provider.extractTasks({ rawText: SMOKE_TEXT, sourceTitle: "冒烟测试" });
  console.log(
    `extract OK: event="${extraction.eventTitle}" tasks=${extraction.tasks.length} ` +
      `evidence=${extraction.tasks.reduce((sum, t) => sum + t.evidence.length, 0)} ` +
      `durationMs=${Date.now() - extractStarted}`,
  );

  const decomposeStarted = Date.now();
  const decomposition = await provider.decomposeTask({
    taskId: "smoke-task",
    title: extraction.eventTitle,
    description: extraction.summary,
    estimatedMinutes: 120,
  });
  console.log(
    `decompose OK: subtasks=${decomposition.subtasks.length} ` +
      `dependencies=${decomposition.subtasks.reduce((sum, s) => sum + s.dependsOn.length, 0)} ` +
      `durationMs=${Date.now() - decomposeStarted}`,
  );
  console.log("Smoke finished. 未写数据库。");
}

main().catch((error) => {
  console.error(`Smoke FAILED: ${(error as Error).message}`);
  process.exitCode = 1;
});
