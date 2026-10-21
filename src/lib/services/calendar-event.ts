import { prisma } from "@/lib/prisma";
import {
  CALENDAR_EVENT_TYPES,
  isValidEnum,
  validateCalendarEvent,
} from "@/lib/domain";
import { runConflictDetection } from "./conflict";

// ============================================================
// 一次性固定事件服务（S5）
// CalendarEvent 是不可由排期引擎移动的固定占用。
// 本阶段仅实现创建与列出，不做删除（避免破坏已解决冲突的历史）。
// ============================================================

export class CalendarEventError extends Error {
  constructor(
    public readonly code: "VALIDATION_FAILED" | "CONFLICT_DETECTION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "CalendarEventError";
  }
}

export interface CreateCalendarEventInput {
  title: string;
  startAt: string;
  endAt: string;
  location?: string | null;
  eventType?: string;
}

export interface CalendarEventView {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  location: string | null;
  eventType: string;
}

function normalizeEventType(value: unknown): string {
  return typeof value === "string" && isValidEnum(CALENDAR_EVENT_TYPES, value) ? value : "OTHER";
}

export async function createCalendarEvent(
  input: CreateCalendarEventInput,
): Promise<{ event: CalendarEventView; newConflicts: number }> {
  const startAt = new Date(input.startAt);
  const endAt = new Date(input.endAt);
  if (Number.isNaN(startAt.getTime())) {
    throw new CalendarEventError("VALIDATION_FAILED", `startAt 不是合法时间：${input.startAt}`);
  }
  if (Number.isNaN(endAt.getTime())) {
    throw new CalendarEventError("VALIDATION_FAILED", `endAt 不是合法时间：${input.endAt}`);
  }

  const error = validateCalendarEvent({
    title: input.title,
    startAt,
    endAt,
    eventType: input.eventType,
  });
  if (error) {
    throw new CalendarEventError("VALIDATION_FAILED", error);
  }

  const event = await prisma.calendarEvent.create({
    data: {
      title: input.title.trim(),
      startAt,
      endAt,
      location: input.location ?? null,
      eventType: normalizeEventType(input.eventType),
    },
  });

  let newConflicts = 0;
  try {
    const created = await runConflictDetection(event.id);
    newConflicts = created.length;
  } catch (error) {
    // 事件已创建，冲突检测失败不应回滚事件；但向上抛出供调用方决定
    throw new CalendarEventError(
      "CONFLICT_DETECTION_FAILED",
      `事件已创建，但冲突检测失败：${(error as Error).message}`,
    );
  }

  return {
    event: {
      id: event.id,
      title: event.title,
      startAt: event.startAt.toISOString(),
      endAt: event.endAt.toISOString(),
      location: event.location,
      eventType: event.eventType,
    },
    newConflicts,
  };
}

export async function listCalendarEvents(): Promise<CalendarEventView[]> {
  const events = await prisma.calendarEvent.findMany({
    orderBy: { startAt: "asc" },
  });
  return events.map((event) => ({
    id: event.id,
    title: event.title,
    startAt: event.startAt.toISOString(),
    endAt: event.endAt.toISOString(),
    location: event.location,
    eventType: event.eventType,
  }));
}
