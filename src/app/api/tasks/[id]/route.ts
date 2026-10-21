import { jsonResponse } from "@/lib/http";
import { getTaskDetail, TaskError } from "@/lib/services/tasks";

/** GET /api/tasks/[id] —— 任务详情、来源、已有子任务与依赖 */
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const detail = await getTaskDetail(id);
    return jsonResponse(detail);
  } catch (error) {
    if (error instanceof TaskError) {
      const status = error.code === "TASK_NOT_FOUND" ? 404 : 422;
      return jsonResponse({ error: error.message, code: error.code }, { status });
    }
    return jsonResponse({ error: "服务器内部错误" }, { status: 500 });
  }
}
