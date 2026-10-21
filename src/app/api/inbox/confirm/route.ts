import { jsonResponse } from "@/lib/http";
import { confirmInbox, InboxError } from "@/lib/services/inbox";

/** POST /api/inbox/confirm —— 服务端复核后事务写入 Source/Task/DecisionLog */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  try {
    const result = await confirmInbox(body);
    return jsonResponse(result, { status: 201 });
  } catch (error) {
    if (error instanceof InboxError) {
      const status =
        error.code === "DUPLICATE_SOURCE"
          ? 409
          : error.code === "PROVIDER_ERROR"
            ? 502
            : error.code === "EMPTY_INPUT"
              ? 400
              : 422;
      return jsonResponse({ error: error.message, code: error.code }, { status });
    }
    return jsonResponse({ error: "服务器内部错误" }, { status: 500 });
  }
}
