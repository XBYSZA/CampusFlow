// ============================================================
// 时间工具（S4）
// 项目统一使用 Asia/Shanghai（UTC+8，无夏令时）作为校园事务时间语义。
// 不引入日期库：固定偏移量换算足够，且结果完全确定、便于测试。
// ============================================================

export const SHANGHAI_OFFSET_MINUTES = 8 * 60;
const SHANGHAI_OFFSET_MS = SHANGHAI_OFFSET_MINUTES * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 可安排时间段：08:00 - 22:00 */
export const PLAN_WINDOW_START_MINUTE = 8 * 60;
export const PLAN_WINDOW_END_MINUTE = 22 * 60;
/** 排期粒度：30 分钟 */
export const PLAN_GRID_MINUTES = 30;

export interface ShanghaiParts {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0=周日 ... 6=周六 */
  weekday: number;
}

/** 把一个 UTC 时刻转换为上海本地的年月日时分（getUTC* 读取偏移后的伪时间） */
export function shanghaiParts(date: Date): ShanghaiParts {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/** 由上海本地时间构造 UTC 时刻（month 为 1-12） */
export function shanghaiDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - SHANGHAI_OFFSET_MS);
}

/** 当天 00:00（上海） */
export function startOfShanghaiDay(date: Date): Date {
  const p = shanghaiParts(date);
  return shanghaiDate(p.year, p.month, p.day, 0, 0);
}

/** 加减天数（上海无夏令时，直接按 24h 平移） */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MS_PER_MINUTE);
}

/** 0=周日 ... 6=周六 */
export function weekdayOf(date: Date): number {
  return shanghaiParts(date).weekday;
}

/** 当天 00:00 起的分钟数（0-1439） */
export function minuteOfDay(date: Date): number {
  const p = shanghaiParts(date);
  return p.hour * 60 + p.minute;
}

/** YYYY-MM-DD（上海） */
export function dateKey(date: Date): string {
  const p = shanghaiParts(date);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** HH:mm（上海） */
export function formatTime(date: Date): string {
  const p = shanghaiParts(date);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** M月D日（上海） */
export function formatDate(date: Date): string {
  const p = shanghaiParts(date);
  return `${p.month}月${p.day}日`;
}

/** M月D日 HH:mm（上海） */
export function formatDateTime(date: Date): string {
  return `${formatDate(date)} ${formatTime(date)}`;
}

/** 所在周的周一 00:00（上海） */
export function weekStartMonday(date: Date): Date {
  const weekday = weekdayOf(date);
  const diff = weekday === 0 ? 6 : weekday - 1;
  return addDays(startOfShanghaiDay(date), -diff);
}

export function ceilToGridMinute(minute: number, grid = PLAN_GRID_MINUTES): number {
  return Math.ceil(minute / grid) * grid;
}

/** 半开区间 [start, end) 是否重叠；首尾相接不算重叠 */
export function intervalsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}
