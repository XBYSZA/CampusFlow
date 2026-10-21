import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  addMinutes,
  formatDateTime,
  formatTime,
  intervalsOverlap,
  startOfShanghaiDay,
  weekdayOf,
} from "@/lib/time";

// ============================================================
// 冲突检测服务（S5）
// 职责：
//   1) 纯函数 detectConflicts：effective Schedules vs Courses / CalendarEvents
//   2) 服务 runConflictDetection：去重写入 Conflict（未解决组合不重复创建）
// 复用 S4 的 [start,end) 半开区间重叠规则：a.start < b.end && b.start < a.end
// ============================================================

export interface DetectedSchedule {
  id: string;
  ownerId: string;
  title: string;
  startAt: Date;
  endAt: Date;
}

export interface DetectedCourse {
  id: string;
  title: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  location?: string | null;
}

export interface DetectedCalendarEvent {
  id: string;
  title: string;
  startAt: Date;
  endAt: Date;
  location?: string | null;
}

export interface DetectedConflict {
  scheduleAId: string;
  courseId: string | null;
  calendarEventId: string | null;
  conflictType: "OVERLAP";
  description: string;
  /** 重叠分钟数，用于解释与去重键（同一固定占用可能多次扫描） */
  overlapMinutes: number;
}

const EFFECTIVE_SCHEDULE_WHERE = { status: { not: "CANCELLED" } } as const;

/**
 * 计算课程在 [rangeStart, rangeEnd) 内的实际发生区间（至少一次）。
 * 用于把"每周三 14:00-15:40"映射为与具体 Schedule 可比的绝对时间。
 */
function courseOccurrencesInRange(
  course: DetectedCourse,
  rangeStart: Date,
  rangeEnd: Date,
): Array<{ startAt: Date; endAt: Date }> {
  const occurrences: Array<{ startAt: Date; endAt: Date }> = [];
  // 从 rangeStart 所在周的周一向前回溯，最多覆盖前后两周，保证不会漏
  const cursor = addMinutes(rangeStart, -7 * 24 * 60);
  const limit = addMinutes(rangeEnd, 7 * 24 * 60);

  let day = cursor;
  while (day.getTime() < limit.getTime()) {
    if (weekdayOf(day) === course.dayOfWeek) {
      const dayStart = startOfShanghaiDay(day);
      const occStart = addMinutes(dayStart, course.startMinute);
      const occEnd = addMinutes(dayStart, course.endMinute);
      if (occEnd.getTime() > rangeStart.getTime() && occStart.getTime() < rangeEnd.getTime()) {
        occurrences.push({ startAt: occStart, endAt: occEnd });
      }
    }
    day = addMinutes(day, 24 * 60);
  }
  return occurrences;
}

/** 重叠分钟数（用于描述，不参与去重键，避免同组合因数值差异重复） */
function overlapMinutes(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return Math.max(0, Math.round((end - start) / 60000));
}

/**
 * 纯冲突检测：输入有效日程、课程、一次性事件，输出检测到的冲突列表。
 * CANCELLED 日程不参与；边界相接（19:00 与 19:00）不算冲突。
 */
export function detectConflicts(params: {
  schedules: DetectedSchedule[];
  courses: DetectedCourse[];
  calendarEvents: DetectedCalendarEvent[];
}): DetectedConflict[] {
  const conflicts: DetectedConflict[] = [];

  for (const schedule of params.schedules) {
    const sStart = schedule.startAt.getTime();
    const sEnd = schedule.endAt.getTime();

    // Schedule vs Course
    for (const course of params.courses) {
      const occurrences = courseOccurrencesInRange(course, schedule.startAt, schedule.endAt);
      for (const occ of occurrences) {
        const cStart = occ.startAt.getTime();
        const cEnd = occ.endAt.getTime();
        if (!intervalsOverlap(sStart, sEnd, cStart, cEnd)) continue;
        const mins = overlapMinutes(sStart, sEnd, cStart, cEnd);
        conflicts.push({
          scheduleAId: schedule.id,
          courseId: course.id,
          calendarEventId: null,
          conflictType: "OVERLAP",
          description: `「${schedule.title}」原计划 ${formatTime(schedule.startAt)}-${formatTime(
            schedule.endAt,
          )}，与课程「${course.title}」${formatTime(occ.startAt)}-${formatTime(
            occ.endAt,
          )} 重叠 ${mins} 分钟。`,
          overlapMinutes: mins,
        });
      }
    }

    // Schedule vs CalendarEvent
    for (const event of params.calendarEvents) {
      const eStart = event.startAt.getTime();
      const eEnd = event.endAt.getTime();
      if (!intervalsOverlap(sStart, sEnd, eStart, eEnd)) continue;
      const mins = overlapMinutes(sStart, sEnd, eStart, eEnd);
      conflicts.push({
        scheduleAId: schedule.id,
        courseId: null,
        calendarEventId: event.id,
        conflictType: "OVERLAP",
        description: `「${schedule.title}」原计划 ${formatDateTime(schedule.startAt)}-${formatDateTime(
          schedule.endAt,
        )}，与临时事件「${event.title}」${formatDateTime(event.startAt)}-${formatDateTime(
          event.endAt,
        )} 重叠 ${mins} 分钟。`,
        overlapMinutes: mins,
      });
    }
  }

  return conflicts;
}

type ConflictRecord = Prisma.ConflictGetPayload<{
  select: { id: true; scheduleAId: true; courseId: true; calendarEventId: true; resolvedAt: true };
}>;

/** 去重键：scheduleA + 固定占用（courseId 或 calendarEventId） */
function conflictKey(scheduleAId: string, courseId: string | null, calendarEventId: string | null): string {
  return `${scheduleAId}|${courseId ?? ""}|${calendarEventId ?? ""}`;
}

/**
 * 读取数据库并运行冲突检测，仅写入"未解决组合"中尚未存在的冲突。
 * @param calendarEventId 可选：仅检测与该一次性事件相关的冲突（创建事件后调用）；
 *                        不传则全量扫描（Schedule vs Course / CalendarEvent）。
 * 返回本次新创建的冲突（便于创建临时事件后立即提示用户）。
 */
export async function runConflictDetection(calendarEventId?: string): Promise<ConflictRecord[]> {
  const [schedules, courses, allCalendarEvents, existing] = await Promise.all([
    prisma.schedule.findMany({
      where: EFFECTIVE_SCHEDULE_WHERE,
      select: {
        id: true,
        startAt: true,
        endAt: true,
        task: { select: { id: true, title: true } },
        subTask: { select: { id: true, title: true } },
      },
    }),
    prisma.course.findMany({
      select: { id: true, title: true, dayOfWeek: true, startMinute: true, endMinute: true, location: true },
    }),
    prisma.calendarEvent.findMany({
      select: { id: true, title: true, startAt: true, endAt: true, location: true },
    }),
    prisma.conflict.findMany({
      where: { resolvedAt: null },
      select: { id: true, scheduleAId: true, courseId: true, calendarEventId: true, resolvedAt: true },
    }),
  ]);

  const calendarEvents = calendarEventId
    ? allCalendarEvents.filter((e) => e.id === calendarEventId)
    : allCalendarEvents;
  // 只扫某个事件时，无需检测 Schedule vs Course（避免产生与本次操作无关的冲突）
  const coursesForDetection = calendarEventId ? [] : courses;

  const detected: DetectedSchedule[] = schedules.map((s) => ({
    id: s.id,
    ownerId: s.subTask?.id ?? s.task?.id ?? "",
    title: s.subTask?.title ?? s.task?.title ?? "未命名日程",
    startAt: s.startAt,
    endAt: s.endAt,
  }));

  const conflicts = detectConflicts({
    schedules: detected,
    courses: coursesForDetection,
    calendarEvents,
  });

  const existingKeys = new Set(
    existing.map((c) => conflictKey(c.scheduleAId, c.courseId, c.calendarEventId)),
  );

  const created: ConflictRecord[] = [];
  for (const conflict of conflicts) {
    const key = conflictKey(conflict.scheduleAId, conflict.courseId, conflict.calendarEventId);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);

    const record = await prisma.conflict.create({
      data: {
        scheduleAId: conflict.scheduleAId,
        courseId: conflict.courseId,
        calendarEventId: conflict.calendarEventId,
        conflictType: conflict.conflictType,
        description: conflict.description,
      },
      select: { id: true, scheduleAId: true, courseId: true, calendarEventId: true, resolvedAt: true },
    });
    created.push(record);
  }

  return created;
}
