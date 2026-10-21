// ============================================================
// AI 层错误类型（S6）
// 上层（Inbox / Tasks 服务、API 路由）据此返回可解释的错误码，
// 页面可以直接展示，不需要猜「AI 到底哪一步失败了」。
// 错误消息中禁止出现 API Key / Authorization / 完整请求头。
// ============================================================

export type AIErrorCode =
  | "AI_CONFIG_INVALID"
  | "AI_REQUEST_FAILED"
  | "AI_TIMEOUT"
  | "AI_RESPONSE_INVALID"
  | "AI_SCHEMA_INVALID"
  | "EVIDENCE_NOT_FOUND"
  | "EVIDENCE_AMBIGUOUS";

export class AIError extends Error {
  /** progressive：目前只有真实的 HTTP Provider 会抛出本错误 */
  readonly provider = "real" as const;

  constructor(
    public readonly code: AIErrorCode,
    message: string,
    /** HTTP 状态码（若错误来自服务端响应） */
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AIError";
  }
}
