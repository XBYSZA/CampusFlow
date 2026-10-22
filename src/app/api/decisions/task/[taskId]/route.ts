import { connection } from "next/server";
import { jsonResponse } from "@/lib/http";
import { buildDecisionTimeline, DecisionError } from "@/lib/services/decision";

/** GET /api/decisions/task/[taskId] —— 聚合任务的决策解释时间线（S7） */
export async function GET(_req: Request, context: { params: Promise<{ taskId: string }> }) {
  await connection();
  const { taskId } = await context.params;
  try {
    const timeline = await buildDecisionTimeline(taskId);
    return jsonResponse(timeline);
  } catch (error) {
    if (error instanceof DecisionError) {
      return jsonResponse({ error: error.message, code: error.code }, { status: 404 });
    }
    return jsonResponse({ error: "服务器内部错误" }, { status: 500 });
  }
}
