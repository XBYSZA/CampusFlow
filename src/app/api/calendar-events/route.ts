import { connection } from "next/server";
import { jsonResponse } from "@/lib/http";
import {
  createCalendarEvent,
  CalendarEventError,
  type CreateCalendarEventInput,
} from "@/lib/services/calendar-event";

/**
 * POST /api/calendar-events
 * 创建一次性固定事件，并立即运行冲突检测。
 * body: { title, startAt: ISO, endAt: ISO, location?, eventType? }
 */
export async function POST(req: Request) {
  await connection();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const input =
    typeof body === "object" && body !== null
      ? (body as Partial<CreateCalendarEventInput>)
      : {};

  if (typeof input.title !== "string" || typeof input.startAt !== "string" || typeof input.endAt !== "string") {
    return jsonResponse(
      { error: "缺少必填字段：title / startAt / endAt", code: "VALIDATION_FAILED" },
      { status: 400 },
    );
  }

  try {
    const result = await createCalendarEvent({
      title: input.title,
      startAt: input.startAt,
      endAt: input.endAt,
      location: typeof input.location === "string" ? input.location : null,
      eventType: typeof input.eventType === "string" ? input.eventType : undefined,
    });
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof CalendarEventError) {
      const status = error.code === "VALIDATION_FAILED" ? 422 : 500;
      return jsonResponse({ error: error.message, code: error.code }, { status });
    }
    return jsonResponse({ error: "服务器内部错误" }, { status: 500 });
  }
}
