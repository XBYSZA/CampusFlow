import { jsonResponse } from "@/lib/http";
import { extractInbox, InboxError } from "@/lib/services/inbox";

/** POST /api/inbox/extract —— 调 AIProvider 提取并校验，不写数据库 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  try {
    const { rawText, sourceTitle } = (body ?? {}) as { rawText?: string; sourceTitle?: string };
    const result = await extractInbox({ rawText, sourceTitle });
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof InboxError) {
      return jsonResponse(
        { error: error.message, code: error.code },
        { status: statusFor(error.code) },
      );
    }
    return jsonResponse({ error: "服务器内部错误" }, { status: 500 });
  }
}

/** 错误码 → HTTP 状态码：配置/超时/请求失败与输入问题的语义要区分清楚 */
function statusFor(code: InboxError["code"]): number {
  switch (code) {
    case "EMPTY_INPUT":
      return 400;
    case "AI_CONFIG_INVALID":
      return 503;
    case "AI_TIMEOUT":
      return 504;
    case "AI_REQUEST_FAILED":
    case "AI_RESPONSE_INVALID":
    case "PROVIDER_ERROR":
      return 502;
    default:
      return 422;
  }
}
