"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  PlanBlock,
  PlanPreview,
  WeekDay,
  WeekScheduleView,
} from "@/lib/planning/contract";
import { dateKey, formatTime, minuteOfDay } from "@/lib/time";

// ============================================================
// 智能日程（S4）
// 周视图：横向 周一 → 周日，纵向 08:00 → 22:00，CSS Grid / 绝对定位自绘。
// 课程 = 固定占用；正式计划 = 已确认日程；预览 = 虚线待确认块。
// ============================================================

const DAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const WINDOW_START = 8 * 60;
const WINDOW_END = 22 * 60;
const SLOT_MINUTES = 30;
const SLOT_HEIGHT = 36;
const HOURS = Array.from({ length: 15 }, (_, index) => 8 + index);

type BlockKind = "COURSE" | "SCHEDULE" | "PREVIEW";

interface SelectedBlock {
  kind: BlockKind;
  title: string;
  startAt: string;
  endAt: string;
  detail?: string | null;
  extra?: string | null;
}

interface ApiError {
  error?: string;
  code?: string;
}

function formatDateLabel(dateKey: string): string {
  const [, month, day] = dateKey.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

function minutesOf(iso: string): number {
  return minuteOfDay(new Date(iso));
}

function topOf(iso: string): number {
  return ((minutesOf(iso) - WINDOW_START) / SLOT_MINUTES) * SLOT_HEIGHT;
}

function heightOf(startAt: string, endAt: string): number {
  const start = minutesOf(startAt);
  const end = Math.max(start + SLOT_MINUTES, minutesOf(endAt));
  const clippedEnd = Math.min(end, WINDOW_END);
  return Math.max(SLOT_HEIGHT, ((clippedEnd - start) / SLOT_MINUTES) * SLOT_HEIGHT - 3);
}

const KIND_STYLE: Record<BlockKind, string> = {
  COURSE: "border border-slate-300 bg-slate-200/90 text-slate-700 hover:bg-slate-200",
  SCHEDULE: "border border-indigo-400 bg-indigo-500 text-white hover:bg-indigo-600",
  PREVIEW:
    "border-2 border-dashed border-amber-500 bg-amber-100/85 text-amber-900 hover:bg-amber-100",
};

const SCHEDULE_STATUS_LABELS: Record<string, string> = {
  CONFIRMED: "已确认",
  PROPOSED: "待确认（历史数据）",
  MOVED: "已调整",
  CANCELLED: "已取消",
};

async function fetchWeek(): Promise<WeekScheduleView> {
  const response = await fetch("/api/schedule", { cache: "no-store" });
  const data = (await response.json()) as WeekScheduleView & ApiError;
  if (!response.ok) {
    throw new Error(data.error ?? "读取日程失败");
  }
  return data;
}

export default function SchedulePage() {
  const [week, setWeek] = useState<WeekScheduleView | null>(null);
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [selected, setSelected] = useState<SelectedBlock | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const refreshWeek = useCallback(async () => {
    try {
      const data = await fetchWeek();
      setWeek(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchWeek();
        if (!cancelled) setWeek(data);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    setNotice(null);
    setSelected(null);
    try {
      const response = await fetch("/api/schedule/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rangeDays: 7 }),
      });
      const data = (await response.json()) as { preview?: PlanPreview } & ApiError;
      if (!response.ok || !data.preview) {
        throw new Error(data.error ?? "生成计划失败");
      }
      setPreview(data.preview);
      setNotice(
        `已生成 ${data.preview.blocks.length} 个计划块，${data.preview.unscheduled.length} 项未能安排；确认后才会写入日程。`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  async function handleConfirm() {
    if (!preview || preview.blocks.length === 0) return;
    setConfirming(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/schedule/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rangeStart: preview.rangeStart,
          rangeEnd: preview.rangeEnd,
          blocks: preview.blocks,
          unscheduled: preview.unscheduled,
        }),
      });
      const data = (await response.json()) as {
        blockCount?: number;
        scheduleCount?: number;
      } & ApiError;
      if (!response.ok) {
        throw new Error(data.error ?? "确认计划失败");
      }
      setPreview(null);
      setSelected(null);
      setNotice(`已写入 ${data.scheduleCount ?? 0} 条正式日程。`);
      await refreshWeek();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConfirming(false);
    }
  }

  const previewsByDate = useMemo(() => {
    const map = new Map<string, PlanBlock[]>();
    for (const block of preview?.blocks ?? []) {
      const key = dateKey(new Date(block.startAt));
      const list = map.get(key) ?? [];
      list.push(block);
      map.set(key, list);
    }
    return map;
  }, [preview]);

  return (
    <main className="flex flex-1 flex-col gap-4 px-6 py-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-slate-900">智能日程</h1>
          <p className="text-sm text-slate-500">
            {week
              ? `${formatDateLabel(week.days[0].dateKey)} - ${formatDateLabel(week.days[6].dateKey)} · 待安排 ${week.pendingCount} 项`
              : "加载本周日程…"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating || confirming || loading}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {generating ? "生成中…" : "生成计划"}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!preview || preview.blocks.length === 0 || confirming}
            className="rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {confirming ? "写入中…" : "确认此计划"}
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}
      {notice && !error && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm border border-slate-300 bg-slate-200" />
          固定课程
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm bg-indigo-500" />
          正式计划
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm border-2 border-dashed border-amber-500 bg-amber-100" />
          预览（未写入）
        </span>
        {preview && (
          <span className="text-slate-400">策略：{preview.strategy}</span>
        )}
      </div>

      <section className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="min-w-[880px]">
          <div
            className="grid border-b border-slate-200 bg-slate-50"
            style={{ gridTemplateColumns: "64px repeat(7, minmax(0, 1fr))" }}
          >
            <div className="px-2 py-2 text-[11px] text-slate-400">时间</div>
            {week?.days.map((day) => (
              <div
                key={day.dateKey}
                className="border-l border-slate-200 px-2 py-2 text-center"
              >
                <div className="text-sm font-medium text-slate-700">
                  {DAY_LABELS[day.weekday]}
                </div>
                <div className="text-[11px] text-slate-400">{formatDateLabel(day.dateKey)}</div>
              </div>
            ))}
          </div>

          <div
            className="grid"
            style={{ gridTemplateColumns: "64px repeat(7, minmax(0, 1fr))" }}
          >
            <div className="relative" style={{ height: (WINDOW_END - WINDOW_START) / SLOT_MINUTES * SLOT_HEIGHT }}>
              {HOURS.map((hour) => (
                <div
                  key={hour}
                  className="absolute right-2 -translate-y-1/2 text-[11px] text-slate-400"
                  style={{ top: ((hour * 60 - WINDOW_START) / SLOT_MINUTES) * SLOT_HEIGHT }}
                >
                  {String(hour).padStart(2, "0")}:00
                </div>
              ))}
            </div>

            {week?.days.map((day) => (
              <DayColumn
                key={day.dateKey}
                day={day}
                previewBlocks={previewsByDate.get(day.dateKey) ?? []}
                onSelect={setSelected}
                selectedKey={selected?.startAt}
              />
            ))}

            {!week &&
              Array.from({ length: 7 }, (_, index) => (
                <div
                  key={index}
                  className="border-l border-slate-200"
                  style={{ height: (WINDOW_END - WINDOW_START) / SLOT_MINUTES * SLOT_HEIGHT }}
                />
              ))}
          </div>
        </div>
      </section>

      {selected && (
        <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-400">
                {selected.kind === "COURSE"
                  ? "固定课程"
                  : selected.kind === "SCHEDULE"
                    ? "已确认计划"
                    : "预览计划（未写入）"}
              </p>
              <h2 className="text-base font-semibold text-slate-900">{selected.title}</h2>
              <p className="text-sm text-slate-500">
                {formatTime(new Date(selected.startAt))} - {formatTime(new Date(selected.endAt))}
                {selected.extra ? ` · ${selected.extra}` : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50"
            >
              关闭
            </button>
          </div>
          {selected.detail && (
            <p className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-sm leading-relaxed text-slate-600">
              {selected.detail}
            </p>
          )}
        </section>
      )}

      <UnscheduledPanel preview={preview} />
    </main>
  );
}

function DayColumn({
  day,
  previewBlocks,
  onSelect,
  selectedKey,
}: {
  day: WeekDay;
  previewBlocks: PlanBlock[];
  onSelect: (block: SelectedBlock) => void;
  selectedKey?: string;
}) {
  const height = ((WINDOW_END - WINDOW_START) / SLOT_MINUTES) * SLOT_HEIGHT;

  return (
    <div
      className="relative border-l border-slate-200"
      style={{
        height,
        backgroundImage:
          "repeating-linear-gradient(to bottom, transparent 0, transparent 70px, rgba(148,163,184,0.22) 70px, rgba(148,163,184,0.22) 72px)",
      }}
    >
      {day.courses.map((course) => (
        <button
          key={course.id}
          type="button"
          onClick={() =>
            onSelect({
              kind: "COURSE",
              title: course.title,
              startAt: course.startAt,
              endAt: course.endAt,
              detail: course.location ? `上课地点：${course.location}` : "固定占用，排期时自动避开。",
              extra: course.location,
            })
          }
          className={`absolute left-1 right-1 overflow-hidden rounded-md px-1.5 py-1 text-left text-[11px] leading-tight transition ${KIND_STYLE.COURSE}`}
          style={{ top: topOf(course.startAt), height: heightOf(course.startAt, course.endAt) }}
        >
          <span className="block truncate font-medium">{course.title}</span>
          <span className="block truncate text-[10px] opacity-70">
            {formatTime(new Date(course.startAt))}-{formatTime(new Date(course.endAt))}
          </span>
          {course.location && (
            <span className="block truncate text-[10px] opacity-70">{course.location}</span>
          )}
        </button>
      ))}

      {day.schedules.map((schedule) => (
        <button
          key={schedule.id}
          type="button"
          onClick={() =>
            onSelect({
              kind: "SCHEDULE",
              title: schedule.title,
              startAt: schedule.startAt,
              endAt: schedule.endAt,
              detail: schedule.rationale,
              extra: SCHEDULE_STATUS_LABELS[schedule.status] ?? schedule.status,
            })
          }
          className={`absolute left-1 right-1 overflow-hidden rounded-md px-1.5 py-1 text-left text-[11px] leading-tight transition ${KIND_STYLE.SCHEDULE} ${
            selectedKey === schedule.startAt ? "ring-2 ring-slate-900 ring-offset-1" : ""
          }`}
          style={{
            top: topOf(schedule.startAt),
            height: heightOf(schedule.startAt, schedule.endAt),
          }}
        >
          <span className="block truncate font-medium">{schedule.title}</span>
          <span className="block truncate text-[10px] opacity-80">
            {formatTime(new Date(schedule.startAt))}-{formatTime(new Date(schedule.endAt))}
          </span>
          {schedule.rationale && (
            <span className="block truncate text-[10px] opacity-70">
              {schedule.rationale}
            </span>
          )}
        </button>
      ))}

      {previewBlocks.map((block) => (
        <button
          key={block.clientId}
          type="button"
          onClick={() =>
            onSelect({
              kind: "PREVIEW",
              title: block.title,
              startAt: block.startAt,
              endAt: block.endAt,
              detail: block.rationale,
              extra: "待确认",
            })
          }
          className={`absolute left-1 right-1 overflow-hidden rounded-md px-1.5 py-1 text-left text-[11px] leading-tight transition ${KIND_STYLE.PREVIEW} ${
            selectedKey === block.startAt ? "ring-2 ring-slate-900 ring-offset-1" : ""
          }`}
          style={{ top: topOf(block.startAt), height: heightOf(block.startAt, block.endAt) }}
        >
          <span className="block truncate font-medium">{block.title}</span>
          <span className="block truncate text-[10px] opacity-80">
            {formatTime(new Date(block.startAt))}-{formatTime(new Date(block.endAt))}
          </span>
          <span className="block truncate text-[10px] opacity-70">{block.rationale}</span>
        </button>
      ))}
    </div>
  );
}

function UnscheduledPanel({ preview }: { preview: PlanPreview | null }) {
  if (!preview) return null;
  if (preview.unscheduled.length === 0) {
    return (
      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500 shadow-sm">
        本次所有待安排对象均已找到时段。
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-800">
        未安排项目（{preview.unscheduled.length}）
      </h2>
      <p className="mt-1 text-xs text-slate-400">
        以下对象未能自动排期，不会被静默丢弃，请手动调整截止时间或预计耗时。
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {preview.unscheduled.map((item) => (
          <li
            key={`${item.ownerType}-${item.ownerId}`}
            className="flex flex-col gap-0.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm"
          >
            <span className="font-medium text-amber-900">{item.title}</span>
            <span className="text-xs text-amber-700">{item.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
