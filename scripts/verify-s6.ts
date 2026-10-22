// ============================================================
// S6 验证：真实 LLM Provider 接入（离线、不消耗真实 API、不写数据库）
//
// 覆盖：
// - Provider 工厂与配置校验（mock / real / 非法 / 缺配置）
// - Real Provider 请求组装（URL / Authorization / model）
// - 超时、有限重试、错误码、密钥不泄漏
// - JSON 代码块有限清理、schema 校验
// - quote → start/end 解析（NOT_FOUND / AMBIGUOUS）
// - Prompt 版本、Mock 不读取真实配置
// - 服务层 aiMeta 留痕
// ============================================================

import { MockAIProvider } from "../src/lib/ai/mock-provider";
import { RealAIProvider, normalizeEstimatedMinutes } from "../src/lib/ai/real-provider";
import { AIConfigError, loadRealLLMConfig, resolveAIProviderKind } from "../src/lib/ai/config";
import { getAIProvider } from "../src/lib/ai";
import {
  DECOMPOSITION_PROMPT_VERSION,
  EXTRACTION_PROMPT_VERSION,
  buildDecompositionMessages,
  buildDecompositionPrompt,
  buildExtractionPrompt,
} from "../src/lib/ai/prompts";
import {
  aiMetaSchema,
  decompositionResultSchema,
  extractionResultSchema,
  validateDecomposition,
  type DecompositionResult,
} from "../src/lib/ai/contract";
import { extractInbox, InboxError } from "../src/lib/services/inbox";
import { DEMO_NOTICE } from "../src/lib/fixtures/demo-notice";

const TEST_KEY = "sk-test-key-must-not-leak-0001";
const BASE_URL = "https://llm.example.test/v1";
const MODEL = "campusflow-test-model";

const RAW_TEXT = "请于10月28日18:00前提交报名表，并参加10月30日的开营仪式。";

const EXTRACTION_JSON = {
  eventTitle: "创新创业训练营报名",
  summary: "需要在 10 月 28 日前提交报名表，并参加开营仪式。",
  tasks: [
    {
      title: "提交报名表",
      description: "在线填写并提交",
      deadline: "2026-10-28T18:00:00+08:00",
      priority: "high",
      estimatedMinutes: 30,
      evidence: [{ quote: "10月28日18:00前提交报名表" }],
    },
  ],
};

const DECOMPOSITION_JSON = {
  taskSummary: "先准备材料，再提交并等待审核。",
  subtasks: [
    {
      clientId: "step-1",
      title: "准备材料",
      description: "整理项目简介",
      estimatedMinutes: 30,
      sortOrder: 0,
      dependsOn: [],
    },
    {
      clientId: "step-2",
      title: "提交报名表",
      description: null,
      estimatedMinutes: 30,
      sortOrder: 1,
      dependsOn: ["step-1"],
    },
  ],
};

// ------------------------------------------------------------
// 断言工具
// ------------------------------------------------------------
let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failures.push(`${name}${detail ? `：${detail}` : ""}`);
    console.log(`FAIL ${name}${detail ? `：${detail}` : ""}`);
  }
}

async function expectCode(name: string, fn: () => Promise<unknown> | unknown, code: string): Promise<void> {
  try {
    await fn();
    check(name, false, `未抛出错误，期望 ${code}`);
  } catch (error) {
    const actual = (error as { code?: string }).code;
    check(name, actual === code, `期望 ${code}，实际 ${actual ?? (error as Error).message}`);
  }
}

// ------------------------------------------------------------
// fetch 打桩（禁止访问真实互联网）
// ------------------------------------------------------------
type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];
const originalFetch = globalThis.fetch;

function chatResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(
  handler: (url: string, init: RequestInit, callIndex: number) => Response | Promise<Response>,
): void {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init, calls.length);
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

const ENV_KEYS = [
  "AI_PROVIDER",
  "REAL_LLM_BASE_URL",
  "REAL_LLM_API_KEY",
  "REAL_LLM_MODEL",
  "REAL_LLM_TIMEOUT_MS",
] as const;

const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

function clearAIConfigEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function setRealEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}): void {
  clearAIConfigEnv();
  process.env.AI_PROVIDER = "real";
  process.env.REAL_LLM_BASE_URL = BASE_URL;
  process.env.REAL_LLM_API_KEY = TEST_KEY;
  process.env.REAL_LLM_MODEL = MODEL;
  process.env.REAL_LLM_TIMEOUT_MS = "30000";
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function makeRealProvider(overrides: { timeoutMs?: number; baseUrl?: string } = {}): RealAIProvider {
  return new RealAIProvider({
    baseUrl: (overrides.baseUrl ?? BASE_URL).replace(/\/+$/, ""),
    apiKey: TEST_KEY,
    model: MODEL,
    timeoutMs: overrides.timeoutMs ?? 30000,
  });
}

async function main(): Promise<void> {
  // ---------- 1. 工厂与配置 ----------
  clearAIConfigEnv();
  check("未设置 AI_PROVIDER 时默认 mock", resolveAIProviderKind() === "mock");
  check("未设置 AI_PROVIDER 时工厂返回 MockAIProvider", getAIProvider() instanceof MockAIProvider);

  process.env.AI_PROVIDER = "mock";
  const mock = getAIProvider();
  check("AI_PROVIDER=mock 返回 MockAIProvider", mock instanceof MockAIProvider);
  check("Mock 元信息 model 为 null", mock.meta.model === null);
  check("Mock 元信息 provider=mock", mock.meta.provider === "mock");

  process.env.AI_PROVIDER = "MOCK";
  check("AI_PROVIDER 大小写不敏感", getAIProvider() instanceof MockAIProvider);

  process.env.AI_PROVIDER = "real";
  await expectCode("AI_PROVIDER=real 缺配置 → AI_CONFIG_INVALID", () => getAIProvider(), "AI_CONFIG_INVALID");

  process.env.AI_PROVIDER = "openai";
  await expectCode("非法 AI_PROVIDER → AI_CONFIG_INVALID", () => getAIProvider(), "AI_CONFIG_INVALID");

  setRealEnv({ REAL_LLM_MODEL: undefined });
  try {
    loadRealLLMConfig();
    check("real 缺少 REAL_LLM_MODEL 被拒绝", false);
  } catch (error) {
    check(
      "real 缺少 REAL_LLM_MODEL 被拒绝",
      error instanceof AIConfigError && (error as AIConfigError).missing.includes("REAL_LLM_MODEL"),
    );
  }

  setRealEnv({ REAL_LLM_BASE_URL: "ftp://bad.example" });
  await expectCode("base URL 协议非法 → AI_CONFIG_INVALID", () => loadRealLLMConfig(), "AI_CONFIG_INVALID");

  setRealEnv({ REAL_LLM_TIMEOUT_MS: "abc" });
  check("非法超时值回落到默认 30000ms", loadRealLLMConfig().timeoutMs === 30000);

  setRealEnv();
  const real = getAIProvider();
  check("AI_PROVIDER=real 返回 RealAIProvider", real instanceof RealAIProvider);
  check("Real Provider 元信息 model 来自环境变量", real.meta.model === MODEL);
  check("Real Provider 不实现 plan/conflict/replan", !("plan" in real) && !("resolveConflict" in real));

  // ---------- 2. 请求组装 ----------
  setRealEnv({ REAL_LLM_BASE_URL: `${BASE_URL}/` });
  installFetch(() => chatResponse(JSON.stringify(EXTRACTION_JSON)));
  const provider = makeRealProvider({ baseUrl: `${BASE_URL}/` });
  await provider.extractTasks({ rawText: RAW_TEXT, sourceTitle: "测试通知" });
  check("请求 URL 拼接为 /chat/completions", calls[0]?.url === `${BASE_URL}/chat/completions`, calls[0]?.url);
  const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
  check("请求携带 Bearer Authorization", headers.authorization === `Bearer ${TEST_KEY}`);
  const body = JSON.parse(String(calls[0]?.init.body)) as {
    model: string;
    messages: Array<{ role: string; content: string }>;
  };
  check("请求体 model 来自配置", body.model === MODEL);
  check(
    "请求体包含 system + user 两条消息，且原文进入 user",
    body.messages.length === 2 &&
      body.messages[0].role === "system" &&
      body.messages[1].content.includes(RAW_TEXT),
  );

  // ---------- 3. 错误 / 超时 / 重试 ----------
  installFetch(() => new Response("unauthorized", { status: 401 }));
  await expectCode("HTTP 401 → AI_REQUEST_FAILED", () => provider.extractTasks({ rawText: RAW_TEXT }), "AI_REQUEST_FAILED");
  check("HTTP 401 不自动重试（仅 1 次请求）", calls.length === 1, `实际 ${calls.length} 次`);
  try {
    await provider.extractTasks({ rawText: RAW_TEXT });
  } catch (error) {
    const message = (error as Error).message;
    check("错误信息不包含 API Key", !message.includes(TEST_KEY), message);
  }

  installFetch((_url, _init, index) =>
    index === 1 ? new Response("server error", { status: 500 }) : chatResponse(JSON.stringify(EXTRACTION_JSON)),
  );
  const retried = await provider.extractTasks({ rawText: RAW_TEXT });
  check("HTTP 500 自动重试 1 次后成功", calls.length === 2 && retried.tasks.length === 1, `实际 ${calls.length} 次`);

  installFetch(() => new Response("server error", { status: 500 }));
  await expectCode("连续 HTTP 500 → AI_REQUEST_FAILED", () => provider.extractTasks({ rawText: RAW_TEXT }), "AI_REQUEST_FAILED");
  check("重试次数上限为 2 次请求", calls.length === 2, `实际 ${calls.length} 次`);

  installFetch(() => Promise.reject(new TypeError("network down")));
  await expectCode("网络错误 → AI_REQUEST_FAILED", () => provider.extractTasks({ rawText: RAW_TEXT }), "AI_REQUEST_FAILED");
  check("网络错误重试后总共 2 次请求", calls.length === 2, `实际 ${calls.length} 次`);

  const timeoutProvider = makeRealProvider({ timeoutMs: 80 });
  installFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );
  await expectCode("请求超时 → AI_TIMEOUT", () => timeoutProvider.extractTasks({ rawText: RAW_TEXT }), "AI_TIMEOUT");
  check("超时不触发重试", calls.length === 1, `实际 ${calls.length} 次`);

  // ---------- 4. 响应解析 ----------
  installFetch(() => chatResponse("```json\n" + JSON.stringify(EXTRACTION_JSON) + "\n```"));
  const fenced = await provider.extractTasks({ rawText: RAW_TEXT });
  check("Markdown 代码块可被有限清理", fenced.eventTitle === EXTRACTION_JSON.eventTitle);

  installFetch(() => chatResponse("这不是 JSON"));
  await expectCode("非 JSON 响应 → AI_RESPONSE_INVALID", () => provider.extractTasks({ rawText: RAW_TEXT }), "AI_RESPONSE_INVALID");

  installFetch(() => chatResponse(""));
  await expectCode("响应缺少 message.content → AI_RESPONSE_INVALID", () => provider.extractTasks({ rawText: RAW_TEXT }), "AI_RESPONSE_INVALID");

  // ---------- 5. quote → start/end ----------
  installFetch(() => chatResponse(JSON.stringify(EXTRACTION_JSON)));
  const extracted = await provider.extractTasks({ rawText: RAW_TEXT });
  const evidence = extracted.tasks[0].evidence[0];
  const expectedStart = RAW_TEXT.indexOf("10月28日18:00前提交报名表");
  check("quote 定位到正确 start", evidence.start === expectedStart, `${evidence.start} vs ${expectedStart}`);
  check(
    "quote 对应 end = start + quote 长度",
    evidence.end === expectedStart + "10月28日18:00前提交报名表".length,
  );
  check("quote 与原文逐字一致", RAW_TEXT.slice(evidence.start, evidence.end) === evidence.quote);
  check(
    "最终结果通过正式 ExtractionResult 契约",
    extractionResultSchema.safeParse({
      eventTitle: extracted.eventTitle,
      summary: extracted.summary,
      tasks: extracted.tasks,
    }).success,
  );

  const missingQuote = structuredClone(EXTRACTION_JSON);
  missingQuote.tasks[0].evidence = [{ quote: "原文中不存在的片段" }];
  installFetch(() => chatResponse(JSON.stringify(missingQuote)));
  await expectCode("quote 不存在 → EVIDENCE_NOT_FOUND", () => provider.extractTasks({ rawText: RAW_TEXT }), "EVIDENCE_NOT_FOUND");

  const duplicateQuote = structuredClone(EXTRACTION_JSON);
  duplicateQuote.tasks[0].evidence = [{ quote: "提交报名表" }];
  installFetch(() => chatResponse(JSON.stringify(duplicateQuote)));
  await expectCode(
    "重复 quote 无法唯一定位 → EVIDENCE_AMBIGUOUS",
    () => provider.extractTasks({ rawText: "提交报名表。提交报名表。" }),
    "EVIDENCE_AMBIGUOUS",
  );

  const badPriority = structuredClone(EXTRACTION_JSON);
  (badPriority.tasks[0] as { priority: string }).priority = "urgent";
  installFetch(() => chatResponse(JSON.stringify(badPriority)));
  await expectCode("非法 priority → AI_SCHEMA_INVALID", () => provider.extractTasks({ rawText: RAW_TEXT }), "AI_SCHEMA_INVALID");

  const noTasks = structuredClone(EXTRACTION_JSON);
  noTasks.tasks = [];
  installFetch(() => chatResponse(JSON.stringify(noTasks)));
  const empty = await provider.extractTasks({ rawText: RAW_TEXT });
  check("tasks 为空数组是合法输出", empty.tasks.length === 0);

  // ---------- 6. 拆解 ----------
  installFetch(() => chatResponse(JSON.stringify(DECOMPOSITION_JSON)));
  const decomposed = await provider.decomposeTask({
    taskId: "verify_s6_task",
    title: "报名训练营",
    estimatedMinutes: 120,
  });
  check("拆解结果通过 candidate 契约", decompositionResultSchema.safeParse(decomposed).success);
  check("拆解结果通过服务端依赖校验", validateDecomposition(decomposed).length === 0);

  const selfDependency: DecompositionResult = {
    taskSummary: "x",
    subtasks: [
      { clientId: "step-1", title: "A", estimatedMinutes: 30, sortOrder: 0, dependsOn: ["step-1"] },
      { clientId: "step-2", title: "B", estimatedMinutes: 30, sortOrder: 1, dependsOn: [] },
    ],
  };
  check(
    "自依赖仍被服务端拒绝",
    validateDecomposition(selfDependency).some((p) => p.includes("不能依赖自己")),
  );

  const cycle: DecompositionResult = {
    taskSummary: "x",
    subtasks: [
      { clientId: "step-1", title: "A", estimatedMinutes: 30, sortOrder: 0, dependsOn: ["step-2"] },
      { clientId: "step-2", title: "B", estimatedMinutes: 30, sortOrder: 1, dependsOn: ["step-1"] },
    ],
  };
  check(
    "循环依赖仍被服务端拒绝",
    validateDecomposition(cycle).some((p) => p.includes("依赖关系存在环")),
  );

  // ---------- 6b. 模型耗时归一化（S7.1） ----------
  check("归一化 5 → 15", normalizeEstimatedMinutes(5) === 15, `${normalizeEstimatedMinutes(5)}`);
  check("归一化 10 → 15", normalizeEstimatedMinutes(10) === 15, `${normalizeEstimatedMinutes(10)}`);
  check("归一化 17 → 30", normalizeEstimatedMinutes(17) === 30, `${normalizeEstimatedMinutes(17)}`);
  check("归一化 31 → 45", normalizeEstimatedMinutes(31) === 45, `${normalizeEstimatedMinutes(31)}`);
  check("归一化 470 → 480", normalizeEstimatedMinutes(470) === 480, `${normalizeEstimatedMinutes(470)}`);
  check("归一化 600 → 480", normalizeEstimatedMinutes(600) === 480, `${normalizeEstimatedMinutes(600)}`);
  check("归一化 15 → 15（边界不抬高）", normalizeEstimatedMinutes(15) === 15);
  check("归一化 480 → 480（上界不溢出）", normalizeEstimatedMinutes(480) === 480);

  const tinyMinutes = structuredClone(DECOMPOSITION_JSON);
  tinyMinutes.subtasks[0].estimatedMinutes = 5;
  tinyMinutes.subtasks[1].estimatedMinutes = 10;
  installFetch(() => chatResponse(JSON.stringify(tinyMinutes)));
  const normalizedResult = await provider.decomposeTask({
    taskId: "verify_s6_task",
    title: "报名训练营",
    estimatedMinutes: 120,
  });
  check(
    "模型返回 5 / 10 分钟 → 正式结果为 15",
    normalizedResult.subtasks[0].estimatedMinutes === 15 &&
      normalizedResult.subtasks[1].estimatedMinutes === 15,
    normalizedResult.subtasks.map((s) => s.estimatedMinutes).join(","),
  );
  check(
    "归一化结果仍通过正式 Decomposition schema",
    decompositionResultSchema.safeParse(normalizedResult).success,
  );
  check(
    "归一化结果仍通过依赖校验",
    validateDecomposition(normalizedResult).length === 0,
  );

  const overMaxMinutes = structuredClone(DECOMPOSITION_JSON);
  overMaxMinutes.subtasks[0].estimatedMinutes = 600;
  overMaxMinutes.subtasks[1].estimatedMinutes = 31;
  installFetch(() => chatResponse(JSON.stringify(overMaxMinutes)));
  const clampedResult = await provider.decomposeTask({
    taskId: "verify_s6_task",
    title: "报名训练营",
    estimatedMinutes: 120,
  });
  check(
    "模型返回 600 / 31 分钟 → 480 / 45",
    clampedResult.subtasks[0].estimatedMinutes === 480 &&
      clampedResult.subtasks[1].estimatedMinutes === 45,
    clampedResult.subtasks.map((s) => s.estimatedMinutes).join(","),
  );

  // 结构错误仍必须拒绝，不能被归一化掩盖
  const selfDependencyJson = structuredClone(DECOMPOSITION_JSON);
  selfDependencyJson.subtasks[0].dependsOn = ["step-1"];
  selfDependencyJson.subtasks[0].estimatedMinutes = 5;
  installFetch(() => chatResponse(JSON.stringify(selfDependencyJson)));
  const selfParsed = await provider.decomposeTask({
    taskId: "verify_s6_task",
    title: "报名训练营",
    estimatedMinutes: 120,
  });
  check(
    "归一化后自依赖仍被服务端拒绝",
    validateDecomposition(selfParsed).some((p) => p.includes("不能依赖自己")),
  );

  const cycleJson = structuredClone(DECOMPOSITION_JSON);
  cycleJson.subtasks[0].dependsOn = ["step-2"];
  cycleJson.subtasks[0].estimatedMinutes = 5;
  installFetch(() => chatResponse(JSON.stringify(cycleJson)));
  const cycleParsed = await provider.decomposeTask({
    taskId: "verify_s6_task",
    title: "报名训练营",
    estimatedMinutes: 120,
  });
  check(
    "归一化后环依赖仍被服务端拒绝",
    validateDecomposition(cycleParsed).some((p) => p.includes("依赖关系存在环")),
  );

  const invalidMinutes = structuredClone(DECOMPOSITION_JSON);
  (invalidMinutes.subtasks[0] as { estimatedMinutes: unknown }).estimatedMinutes = "abc";
  installFetch(() => chatResponse(JSON.stringify(invalidMinutes)));
  await expectCode(
    "estimatedMinutes 非数字 → 仍被 candidate 拒绝",
    () => provider.decomposeTask({ taskId: "verify_s6_task", title: "报名训练营", estimatedMinutes: 120 }),
    "AI_SCHEMA_INVALID",
  );

  const zeroMinutes = structuredClone(DECOMPOSITION_JSON);
  zeroMinutes.subtasks[0].estimatedMinutes = 0;
  installFetch(() => chatResponse(JSON.stringify(zeroMinutes)));
  await expectCode(
    "estimatedMinutes=0 → 仍被 candidate 拒绝",
    () => provider.decomposeTask({ taskId: "verify_s6_task", title: "报名训练营", estimatedMinutes: 120 }),
    "AI_SCHEMA_INVALID",
  );

  // ---------- 7. Prompt 版本与模板 ----------
  check("提取 Prompt 版本存在", EXTRACTION_PROMPT_VERSION === "1.0");
  check("拆解 Prompt 版本提升至 1.1", DECOMPOSITION_PROMPT_VERSION === "1.1", DECOMPOSITION_PROMPT_VERSION);
  const extractionPrompt = buildExtractionPrompt({ rawText: RAW_TEXT, sourceTitle: "通知" });
  check("提取 Prompt 包含原文与来源标题", extractionPrompt.includes(RAW_TEXT) && extractionPrompt.includes("通知"));
  const decompositionPrompt = buildDecompositionPrompt({
    taskId: "verify_s6_task",
    title: "报名训练营",
    estimatedMinutes: 120,
  });
  check("拆解 Prompt 包含任务标题与耗时", decompositionPrompt.includes("报名训练营") && decompositionPrompt.includes("120"));

  const decompositionSystemPrompt = buildDecompositionMessages({
    taskId: "verify_s6_task",
    title: "报名训练营",
    estimatedMinutes: 120,
  })[0].content;
  check(
    "拆解 Prompt v1.1 明确 >=15 且 <=480",
    decompositionSystemPrompt.includes(">= 15") && decompositionSystemPrompt.includes("<= 480"),
  );
  check(
    "拆解 Prompt v1.1 明确 15 分钟粒度",
    decompositionSystemPrompt.includes("15 分钟粒度") &&
      decompositionSystemPrompt.includes("15 / 30 / 45 / 60"),
  );
  check(
    "拆解 Prompt v1.1 明确 2~8 个子任务与粒度匹配",
    decompositionSystemPrompt.includes("2~8") &&
      decompositionSystemPrompt.includes("30 分钟的简单任务不应拆成很多个 5 分钟步骤"),
  );

  // ---------- 8. aiMeta 契约 ----------
  check(
    "aiMeta 契约接受 mock/real 且剔除未知字段",
    aiMetaSchema.safeParse({
      provider: "real",
      model: MODEL,
      promptVersion: "1.0",
      durationMs: 1200,
      apiKey: TEST_KEY,
    }).success,
  );

  // ---------- 9. 服务层：Mock 不读真实配置 ----------
  process.env.AI_PROVIDER = "mock";
  process.env.REAL_LLM_API_KEY = "should-not-be-read";
  process.env.REAL_LLM_BASE_URL = "";
  process.env.REAL_LLM_MODEL = "";
  const mockResult = await extractInbox({
    rawText: DEMO_NOTICE.rawText,
    sourceTitle: DEMO_NOTICE.title,
  });
  check("Mock 模式不读取 REAL_LLM_* 也能提取", mockResult.tasks.length > 0);
  check("Mock 结果 aiMeta.provider=mock", mockResult.aiMeta.provider === "mock");
  check("Mock 结果 provider=mock 且 model 为 null", mockResult.provider === "mock" && mockResult.model === null);
  check("Mock 结果包含 promptVersion 与 durationMs", Boolean(mockResult.promptVersion) && mockResult.durationMs >= 0);

  // ---------- 10. 服务层：Real 失败不 fallback ----------
  clearAIConfigEnv();
  process.env.AI_PROVIDER = "real";
  try {
    await extractInbox({ rawText: RAW_TEXT });
    check("real 缺配置时服务层抛 AI_CONFIG_INVALID", false);
  } catch (error) {
    check(
      "real 缺配置时服务层抛 AI_CONFIG_INVALID（不回退 Mock）",
      error instanceof InboxError && error.code === "AI_CONFIG_INVALID",
    );
  }

  // ---------- 11. 服务层：Real 成功时 aiMeta 留痕 ----------
  setRealEnv();
  installFetch(() => chatResponse(JSON.stringify(EXTRACTION_JSON)));
  const realResult = await extractInbox({ rawText: RAW_TEXT, sourceTitle: "Real 通知" });
  check("Real 结果 aiMeta.provider=real", realResult.aiMeta.provider === "real");
  check("Real 结果 aiMeta.model 来自配置", realResult.aiMeta.model === MODEL);
  check("Real 结果 aiMeta.promptVersion=提取 Prompt 版本", realResult.aiMeta.promptVersion === EXTRACTION_PROMPT_VERSION);
  check("Real 结果记录 durationMs", typeof realResult.aiMeta.durationMs === "number");
  check("Real 结果 provider=real", realResult.provider === "real");
}

main()
  .catch((error) => {
    failures.push(`脚本异常：${(error as Error).message}`);
    console.error(error);
  })
  .finally(() => {
    restoreFetch();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    console.log(`\nS6 verification: ${passed} passed, ${failures.length} failed`);
    if (failures.length > 0) {
      for (const item of failures) console.error(`FAILED: ${item}`);
      process.exitCode = 1;
      return;
    }
    console.log("PASS: S6 verification succeeded.");
  });
