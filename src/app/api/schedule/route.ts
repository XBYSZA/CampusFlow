import { connection } from "next/server";
import { jsonResponse } from "@/lib/http";
import { getWeekSchedule, ScheduleError } from "@/lib/services/schedule";

/** GET /api/schedule —— 本周课程、已确认日程与待安排数量 */
export async function GET() {
  // 周视图依赖数据库实时状态，必须动态渲染
  await connection();
  try {
    const data = await getWeekSchedule();
    return jsonResponse(data);
  } catch (error) {
    if (error instanceof ScheduleError) {
      return jsonResponse({ error: error.message, code: error.code }, { status: 400 });
    }
    return jsonResponse({ error: "服务器内部错误" }, { status: 500 });
  }
}
