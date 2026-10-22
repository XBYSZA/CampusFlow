import { jsonResponse } from "@/lib/http";
import { confirmPlan, ScheduleError } from "@/lib/services/schedule";

/**
 * POST /api/schedule/confirm
 * 服务端重新查询数据库并逐条复核约束，事务写入 Schedule + DecisionLog(PLAN)。
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  try {
    const result = await confirmPlan(body);
    return jsonResponse(result, { status: 201 });
  } catch (error) {
    if (error instanceof ScheduleError) {
      const status =
        error.code === "ALREADY_SCHEDULED"
          ? 409
          : error.code === "VALIDATION_FAILED" ||
              error.code === "BLOCK_INVALID" ||
              error.code === "BLOCK_IN_PAST" ||
              error.code === "BLOCK_OUT_OF_RANGE" ||
              error.code === "DEADLINE_EXCEEDED" ||
              error.code === "COURSE_OVERLAP" ||
              error.code === "CALENDAR_EVENT_OVERLAP" ||
              error.code === "SCHEDULE_OVERLAP" ||
              error.code === "BLOCK_OVERLAP" ||
              error.code === "DEPENDENCY_VIOLATION" ||
              error.code === "DURATION_MISMATCH" ||
              error.code === "PARENT_WITH_SUBTASKS" ||
              error.code === "OWNER_NOT_FOUND" ||
              error.code === "OWNER_TYPE_MISMATCH"
            ? 422
            : 400;
      return jsonResponse({ error: error.message, code: error.code }, { status });
    }
    return jsonResponse({ error: "服务器内部错误" }, { status: 500 });
  }
}
