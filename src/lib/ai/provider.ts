import type { DecompositionResult, ExtractionResult } from "./contract";

// ============================================================
// AIProvider 抽象（S2 提取 / S3 拆解）
// Inbox、Tasks 页面与数据库逻辑只依赖本接口；
// 未来接入真实大模型时只需新增 RealAIProvider，
// 无需改动上层任何代码。
// ============================================================

export interface ExtractTasksInput {
  /** 通知原文 */
  rawText: string;
  /** 来源标题（可选，辅助提取事件名） */
  sourceTitle?: string;
}

export interface DecomposeTaskInput {
  /** 主任务 ID（仅作上下文，Provider 不应依赖它生成结果） */
  taskId: string;
  title: string;
  description?: string | null;
  /** ISO 时间字符串，无截止为 null */
  deadline?: string | null;
  estimatedMinutes?: number | null;
  /** 来源上下文（如通知原文摘要），可选 */
  sourceContext?: string;
}

/** Provider 元信息：用于页面展示与 DecisionLog 留痕（不含任何密钥） */
export interface AIProviderMeta {
  provider: "mock" | "real";
  /** real 时是实际模型名；mock 为 null（不暴露无意义的假模型名） */
  model: string | null;
  extractionPromptVersion: string;
  decompositionPromptVersion: string;
}

export interface AIProvider {
  /** Provider 名称，用于 DecisionLog 记录与调试 */
  readonly name: string;
  /** 元信息（provider / model / prompt 版本） */
  readonly meta: AIProviderMeta;
  /**
   * 从非结构化文本中提取事件与任务。
   * 实现方必须保证返回值满足 extractionResultSchema（Zod），
   * 且所有 evidence 与 rawText 精确一致。
   */
  extractTasks(input: ExtractTasksInput): Promise<ExtractionResult>;

  /**
   * 将主任务拆解为可执行子任务，并给出依赖顺序建议。
   * 实现方必须保证返回值满足 decompositionResultSchema（Zod），
   * 且依赖图无环（服务端仍会二次校验）。
   */
  decomposeTask(input: DecomposeTaskInput): Promise<DecompositionResult>;
}
