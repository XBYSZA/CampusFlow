import type {
  ContractPriority,
  DecompositionResult,
  Evidence,
  ExtractedTask,
  ExtractionResult,
  ProposedSubTask,
} from "./contract";
import type {
  AIProvider,
  AIProviderMeta,
  DecomposeTaskInput,
  ExtractTasksInput,
} from "./provider";

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

// ---------- 拆解规则（S3） ----------
interface DecomposeStep {
  title: string;
  description: string;
  /** 占总耗时的权重 */
  weight: number;
}

interface DecomposeRule {
  keywords: string[];
  steps: DecomposeStep[];
}

const DEFAULT_TOTAL_MINUTES = 120;

// 关键词 → 拆解步骤模板（按顺序取第一个命中的规则）
const DECOMPOSE_RULES: DecomposeRule[] = [
  {
    keywords: ["方案", "策划", "作品", "文档", "报告", "论文", "设计"],
    steps: [
      { title: "梳理要求与评分点", description: "通读通知与评分标准，列出必须覆盖的要点", weight: 0.2 },
      { title: "完成方案初稿", description: "按要点撰写主体内容，先保证结构完整", weight: 0.55 },
      { title: "检查格式并提交", description: "核对格式、命名与提交渠道后提交", weight: 0.25 },
    ],
  },
  {
    keywords: ["报名", "登记", "注册"],
    steps: [
      { title: "准备报名所需材料", description: "确认队伍信息、证件与作品简介是否齐全", weight: 0.3 },
      { title: "填写并核对报名表", description: "逐项填写报名信息，重点核对联系方式和成员名单", weight: 0.45 },
      { title: "确认提交并留存回执", description: "提交后保存回执截图，确认报名成功", weight: 0.25 },
    ],
  },
  {
    keywords: ["路演", "答辩", "汇报", "ppt", "展示", "演讲"],
    steps: [
      { title: "整理讲稿要点", description: "按时间限制拆出开场、主体与结论", weight: 0.25 },
      { title: "制作演示文稿", description: "完成 PPT 主体页面与关键图示", weight: 0.5 },
      { title: "计时演练并修订", description: "完整演练一遍并按实际时长精简内容", weight: 0.25 },
    ],
  },
  {
    keywords: ["复习", "考试", "课程", "测验"],
    steps: [
      { title: "梳理知识框架", description: "整理章节要点与重点概念", weight: 0.3 },
      { title: "完成配套练习", description: "按章节完成题目并标注不确定项", weight: 0.45 },
      { title: "总结错题与盲点", description: "回看错题，补齐薄弱环节", weight: 0.25 },
    ],
  },
];

// 识别不出具体类型时的通用三步（保持克制，不凭空生成大量步骤）
const FALLBACK_STEPS: DecomposeStep[] = [
  { title: "明确任务要求与范围", description: "确认交付物形式、截止时间与验收标准", weight: 0.25 },
  { title: "执行主体工作", description: "按计划完成核心产出", weight: 0.5 },
  { title: "检查成果并收尾", description: "自查完整性后提交或归档", weight: 0.25 },
];

function clampMinutes(minutes: number): number {
  return Math.min(480, Math.max(45, Math.round(minutes)));
}

/** 按权重分配分钟数，取整到 5 分钟并保证 15~480 区间（确定性计算） */
function distributeMinutes(total: number, weight: number): number {
  const raw = total * weight;
  const rounded = Math.round(raw / 5) * 5;
  return Math.min(480, Math.max(15, rounded));
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
  /** Mock 不使用 Prompt 模板，版本号标记为规则版本，便于日志区分 */
  readonly meta: AIProviderMeta = {
    provider: "mock",
    model: null,
    extractionPromptVersion: "mock-rules-1.0",
    decompositionPromptVersion: "mock-rules-1.0",
  };

  /**
   * 任务拆解（S3，开发期 Mock）
   * 按标题/描述中的关键词选择一套步骤模板，再按权重把总耗时拆到各步骤，
   * 步骤之间形成链式依赖（后一步依赖前一步）。规则确定性，同一输入结果一致。
   */
  async decomposeTask(input: DecomposeTaskInput): Promise<DecompositionResult> {
    await sleep(500 + Math.random() * 500);

    const haystack = `${input.title}\n${input.description ?? ""}`.toLowerCase();
    const matched = DECOMPOSE_RULES.find((rule) =>
      rule.keywords.some((kw) => haystack.includes(kw)),
    );
    // 识别不了具体类型时返回通用三步，不凭空堆砌大量步骤
    const steps = matched?.steps ?? FALLBACK_STEPS;

    const totalMinutes = clampMinutes(input.estimatedMinutes ?? DEFAULT_TOTAL_MINUTES);
    const subtasks: ProposedSubTask[] = steps.map((step, index) => ({
      clientId: `step-${index + 1}`,
      title: step.title,
      description: step.description,
      estimatedMinutes: distributeMinutes(totalMinutes, step.weight),
      sortOrder: index,
      dependsOn: index === 0 ? [] : [`step-${index}`],
    }));

    const totalAssigned = subtasks.reduce((sum, s) => sum + s.estimatedMinutes, 0);
    const deadlineHint = input.deadline ? `，截止 ${input.deadline.slice(0, 10)}` : "";
    return {
      taskSummary: `将「${input.title}」拆解为 ${subtasks.length} 个按顺序执行的子任务，合计约 ${totalAssigned} 分钟${deadlineHint}。`,
      subtasks,
    };
  }

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
