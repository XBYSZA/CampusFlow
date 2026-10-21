import { connection } from "next/server";
import { jsonResponse } from "@/lib/http";
import { listTasks, TaskError } from "@/lib/services/tasks";

/** GET /api/tasks —— 任务列表（含来源标题与已拆解子任务数） */
export async function GET() {
  // 任务列表依赖数据库实时状态，必须在每次请求时动态渲染
  await connection();
  try {
    const tasks = await listTasks();
    return jsonResponse({ tasks });
  } catch (error) {
    if (error instanceof TaskError) {
      return jsonResponse({ error: error.message, code: error.code }, { status: 400 });
    }
    return jsonResponse({ error: "服务器内部错误" }, { status: 500 });
  }
}
