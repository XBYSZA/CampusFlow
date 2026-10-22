import { jsonResponse } from "@/lib/http";
import { completeSubTask, CompleteError } from "@/lib/services/completion";

/** POST /api/subtasks/[id]/complete —— 完成一个执行步骤（最后一个完成时自动完成父任务） */
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const result = await completeSubTask(id);
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof CompleteError) {
      const status = error.code === "SUBTASK_NOT_FOUND" ? 404 : 422;
      return jsonResponse({ error: error.message, code: error.code }, { status });
    }
    return jsonResponse({ error: "服务器内部错误" }, { status: 500 });
  }
}
