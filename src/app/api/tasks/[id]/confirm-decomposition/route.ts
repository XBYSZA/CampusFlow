import { jsonResponse } from "@/lib/http";
import { confirmDecomposition, TaskError } from "@/lib/services/tasks";

/** POST /api/tasks/[id]/confirm-decomposition —— 复核后事务写入子任务与依赖 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  try {
    const result = await confirmDecomposition(id, body);
    return jsonResponse(result, { status: 201 });
  } catch (error) {
    if (error instanceof TaskError) {
      const status =
        error.code === "TASK_NOT_FOUND"
          ? 404
          : error.code === "ALREADY_DECOMPOSED"
            ? 409
            : error.code === "PROVIDER_ERROR"
              ? 502
              : 422;
      return jsonResponse({ error: error.message, code: error.code }, { status });
    }
    return jsonResponse({ error: "服务器内部错误" }, { status: 500 });
  }
}
