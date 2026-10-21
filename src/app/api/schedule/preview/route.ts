import { jsonResponse } from "@/lib/http";
import { generatePlanPreview, ScheduleError } from "@/lib/services/schedule";

/**
 * POST /api/schedule/preview
 * 只读数据库并生成预览，不写入任何 Schedule。
 * body: { rangeStart?: ISO, rangeDays?: number }
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const input =
    typeof body === "object" && body !== null
      ? (body as { rangeStart?: unknown; rangeDays?: unknown })
      : {};

  const rangeStart =
    typeof input.rangeStart === "string" ? input.rangeStart : null;
  const rangeDays =
    typeof input.rangeDays === "number" ? input.rangeDays : null;

  try {
    const preview = await generatePlanPreview({ rangeStart, rangeDays });
    return jsonResponse({ preview });
  } catch (error) {
    if (error instanceof ScheduleError) {
      const status =
        error.code === "VALIDATION_FAILED" || error.code === "PLAN_INVALID" ? 422 : 400;
      return jsonResponse({ error: error.message, code: error.code }, { status });
    }
    return jsonResponse({ error: "服务器内部错误" }, { status: 500 });
  }
}
