// ============================================================
// Prompt 模板（S6）
// 集中管理、可阅读、带版本号：
// DecisionLog 只记录版本号，不记录完整 Prompt（模板本身在 Git 仓库里）。
// 修改 Prompt 语义时必须同步提升版本号，保证演示可复现。
// ============================================================

import type { DecomposeTaskInput, ExtractTasksInput } from "./provider";

export const EXTRACTION_PROMPT_VERSION = "1.0";
export const DECOMPOSITION_PROMPT_VERSION = "1.0";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

const JSON_ONLY_RULE =
  "只输出一个 JSON 对象。禁止输出 Markdown 代码块（如 ```json）、注释、解释或任何前后缀文字。";

// ---------- 提取 ----------

const EXTRACTION_SYSTEM_PROMPT = `你是 CampusFlow 的校园信息提取助手，任务是把校园通知原文转换成结构化任务列表。

严格规则：
1. ${JSON_ONLY_RULE}
2. 所有内容必须来自原文，禁止根据常识补充原文中不存在的信息。
3. 原文没有明确截止时间时，deadline 必须为 null，禁止推测（例如不要因为"尽快"就编造日期）。
4. evidence 的 quote 必须逐字复制原文中的连续片段：不得改写、不得拼接、不得省略、不得添加标点。
5. 不要输出 evidence 的 start / end 字符位置，服务端会根据 quote 在原文中定位。
6. 每个任务至少 1 条、最多 10 条 evidence；同一个 quote 不要重复用在多个任务里，且该 quote 在原文中必须唯一出现。
7. estimatedMinutes 必须是 15~480 的整数，表示完成该任务需要的时间；原文未说明时按任务复杂度合理估计。
8. priority 只能是 "low" / "medium" / "high"。
9. 不要输出数据库 ID、不要安排具体时间、不要生成日程。
10. 原文没有可执行任务时，tasks 返回空数组。

输出 JSON 结构：
{
  "eventTitle": "事件名称（≤120 字）",
  "summary": "一句话概括（≤500 字）",
  "tasks": [
    {
      "title": "任务标题（≤100 字）",
      "description": "补充说明（可选，≤500 字）",
      "deadline": "ISO 8601 时间，例如 2026-10-28T18:00:00+08:00；无法确定时为 null",
      "priority": "low | medium | high",
      "estimatedMinutes": 60,
      "evidence": [{ "quote": "原文中逐字复制的连续片段" }]
    }
  ]
}`;

export function buildExtractionPrompt(input: ExtractTasksInput): string {
  const title = input.sourceTitle?.trim() ? input.sourceTitle.trim() : "（未提供标题）";
  return `来源标题：${title}

通知原文（三个尖括号之间的全部内容，quote 必须从这里逐字复制）：
<<<
${input.rawText}
>>>`;
}

export function buildExtractionMessages(input: ExtractTasksInput): ChatMessage[] {
  return [
    { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
    { role: "user", content: buildExtractionPrompt(input) },
  ];
}

// ---------- 拆解 ----------

const DECOMPOSITION_SYSTEM_PROMPT = `你是 CampusFlow 的任务拆解助手，任务是把一个校园事务拆成可直接执行的子任务。

严格规则：
1. ${JSON_ONLY_RULE}
2. 子任务数量必须是 2~8 个；2 小时的任务不要拆成 20 步，粒度要合理。
3. clientId 使用简单稳定的字符串：step-1、step-2……按执行顺序编号。
4. sortOrder 从 0 开始连续递增且不重复，与执行顺序一致。
5. dependsOn 只能引用同一批结果里出现过的 clientId；第一个子任务用空数组；禁止依赖自己。
6. 禁止输出任何数据库 ID、任务 ID 或真实系统标识。
7. estimatedMinutes 必须是 15~480 的整数，各子任务合计尽量接近主任务预计耗时。
8. 依赖关系只是建议，服务端会做最终校验；但不要故意构造环。
9. 不要安排具体日期时间，不要生成日程。

输出 JSON 结构：
{
  "taskSummary": "对拆解思路的一句话概括（≤500 字）",
  "subtasks": [
    {
      "clientId": "step-1",
      "title": "子任务标题（≤100 字）",
      "description": "子任务说明（可选，≤500 字）",
      "estimatedMinutes": 30,
      "sortOrder": 0,
      "dependsOn": []
    }
  ]
}`;

export function buildDecompositionPrompt(input: DecomposeTaskInput): string {
  const lines = [
    `任务标题：${input.title}`,
    `任务描述：${input.description?.trim() ? input.description.trim() : "（无）"}`,
    `截止时间：${input.deadline ?? "（未设置）"}`,
    `预计耗时：${input.estimatedMinutes ?? "（未设置）"}${input.estimatedMinutes ? " 分钟" : ""}`,
  ];
  if (input.sourceContext?.trim()) {
    lines.push(`来源上下文：\n<<<\n${input.sourceContext.trim()}\n>>>`);
  }
  return lines.join("\n");
}

export function buildDecompositionMessages(input: DecomposeTaskInput): ChatMessage[] {
  return [
    { role: "system", content: DECOMPOSITION_SYSTEM_PROMPT },
    { role: "user", content: buildDecompositionPrompt(input) },
  ];
}
