import { jsonResponse } from "@/lib/http";
import { completeTask, CompleteError } from "@/lib/services/completion";

/** POST /api/tasks/[id]/complete —— 完成一个没有子任务的任务 */
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const result = await completeTask(id);
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof CompleteError) {
      const status =
        error.code === "TASK_NOT_FOUND"
          ? 404
          : error.code === "TASK_HAS_INCOMPLETE_SUBTASKS"
            ? 409
            : 422;
      return jsonResponse({ error: error.message, code: error.code }, { status });
    }
    return jsonResponse({ error: "服务器内部错误" }, { status: 500 });
  }
}
