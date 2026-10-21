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
      const status =
        error.code === "EMPTY_INPUT" ? 400 : error.code === "PROVIDER_ERROR" ? 502 : 422;
      return jsonResponse({ error: error.message, code: error.code }, { status });
    }
    return jsonResponse({ error: "服务器内部错误" }, { status: 500 });
  }
}
