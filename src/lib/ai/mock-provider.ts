import type { ContractPriority, Evidence, ExtractedTask, ExtractionResult } from "./contract";
import type { AIProvider, ExtractTasksInput } from "./provider";

// ============================================================
// MockAIProvider（开发期 Mock，S2）
//
// ⚠️ 定位说明：
// - 本 Provider 仅用于开发、测试与断网兜底；
// - 最终参赛版本将并存 RealAIProvider，二者实现同一 AIProvider 接口，
//   通过环境变量 AI_PROVIDER=mock|real 切换；
// - 本实现基于确定性规则（日期识别 + 任务关键词分类），
//   对同一样本多次运行输出完全一致；
// - 保守原则：无法可靠识别的内容宁可不提取，也不编造。
// ============================================================

// 日期识别：2026 年 10 月 28 日 18:00 / 2026 年 11 月 5 日（时间可缺省）
const DATE_RE =
  /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2})\s*[:：]\s*(\d{2}))?/;

interface TaskRule {
  keywords: string[];
  title: string;
  priority: ContractPriority;
  estimatedMinutes: number;
}

// 关键词 → 任务模板（按顺序取第一个命中的规则）
const TASK_RULES: TaskRule[] = [
  { keywords: ["报名"], title: "提交报名材料", priority: "high", estimatedMinutes: 45 },
  { keywords: ["方案", "作品"], title: "提交项目方案", priority: "high", estimatedMinutes: 180 },
  { keywords: ["路演", "答辩"], title: "参加路演答辩", priority: "medium", estimatedMinutes: 60 },
  { keywords: ["提交", "截止"], title: "完成材料提交", priority: "medium", estimatedMinutes: 60 },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 解析日期匹配为 ISO 字符串（+08:00）。无时间分量时返回 null（不猜测时刻）。 */
function parseDateMatch(match: RegExpMatchArray): string | null {
  const [, year, month, day, hour, minute] = match;
  if (hour === undefined || minute === undefined) return null;
  const pad = (v: string) => v.padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+08:00`;
}

/** 从原文中截取事件标题：优先取「关于举办…的通知」之间的内容 */
function extractEventTitle(rawText: string, sourceTitle?: string): string {
  const aboutMatch = rawText.match(/关于举办\s*([^，。\n]+?)\s*的通知/);
  if (aboutMatch) return aboutMatch[1].trim();
  const bracketMatch = rawText.match(/【([^】]+)】/);
  if (bracketMatch) return `${bracketMatch[1].trim()}相关事项`;
  if (sourceTitle?.trim()) return sourceTitle.trim();
  return "未命名校园事件";
}

/** 在一句文本中寻找「同时包含日期与任务关键词」的任务线索 */
function findRule(text: string): TaskRule | null {
  for (const rule of TASK_RULES) {
    if (rule.keywords.some((kw) => text.includes(kw))) return rule;
  }
  return null;
}

export class MockAIProvider implements AIProvider {
  readonly name = "mock";

  async extractTasks(input: ExtractTasksInput): Promise<ExtractionResult> {
    // 模拟 500~1000ms 分析延迟，便于展示「AI 正在分析」状态（不影响结果确定性）
    await sleep(500 + Math.random() * 500);

    const { rawText, sourceTitle } = input;
    const eventTitle = extractEventTitle(rawText, sourceTitle);
    const tasks: ExtractedTask[] = [];
    const seenTitles = new Set<string>();

    // 按行扫描（保留偏移量，保证 evidence start/end 精确）
    let offset = 0;
    const lines = rawText.split("\n");
    for (const rawLine of lines) {
      const lineStart = rawText.indexOf(rawLine, offset);
      offset = lineStart + rawLine.length;

      const dateMatch = rawLine.match(DATE_RE);
      if (!dateMatch) continue;
      const rule = findRule(rawLine);
      if (!rule) continue; // 保守：有日期但没有任务关键词 → 不提取
      if (seenTitles.has(rule.title)) continue; // 同类任务去重

      // evidence：优先取行内包含日期的分句（。；; 分隔），否则取整行
      const segments = rawLine.split(/[。；;]/).map((s) => s.trim()).filter(Boolean);
      const sentence =
        segments.find((seg) => DATE_RE.test(seg) && findRule(seg) !== null) ?? rawLine.trim();
      if (!sentence) continue;

      const start = rawText.indexOf(sentence, lineStart);
      if (start < 0) continue;
      const end = start + sentence.length;
      const evidence: Evidence = {
        quote: rawText.slice(start, end), // 由 slice 构造，天然保证与 quote 一致
        start,
        end,
      };

      seenTitles.add(rule.title);
      tasks.push({
        title: rule.title,
        description: rawLine.trim().slice(0, 200),
        deadline: parseDateMatch(dateMatch),
        priority: rule.priority,
        estimatedMinutes: rule.estimatedMinutes,
        evidence: [evidence],
      });
    }

    const datedTasks = tasks.filter((t) => t.deadline !== null);
    const summary =
      tasks.length === 0
        ? "未能从文本中可靠识别出任务，请人工整理后重试。"
        : `从「${eventTitle}」中识别出 ${tasks.length} 项任务，其中 ${datedTasks.length} 项带有明确截止时间。`;

    return { eventTitle, summary, tasks };
  }
}
