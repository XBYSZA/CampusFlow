import { jsonResponse } from "@/lib/http";
import { decomposeTask, TaskError } from "@/lib/services/tasks";

/** POST /api/tasks/[id]/decompose —— 生成拆解预览，不写数据库 */
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const preview = await decomposeTask(id);
    return jsonResponse(preview);
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
