import type { ExtractionResult } from "./contract";

// ============================================================
// AIProvider 抽象（S2）
// Inbox 页面与数据库逻辑只依赖本接口；
// 未来接入真实大模型时只需新增 RealAIProvider，
// 无需改动上层任何代码。
// ============================================================

export interface ExtractTasksInput {
  /** 通知原文 */
  rawText: string;
  /** 来源标题（可选，辅助提取事件名） */
  sourceTitle?: string;
}

export interface AIProvider {
  /** Provider 名称，用于 DecisionLog 记录与调试 */
  readonly name: string;
  /**
   * 从非结构化文本中提取事件与任务。
   * 实现方必须保证返回值满足 extractionResultSchema（Zod），
   * 且所有 evidence 与 rawText 精确一致。
   */
  extractTasks(input: ExtractTasksInput): Promise<ExtractionResult>;
}
