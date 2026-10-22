"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import DecisionDrawer from "@/components/decision-drawer";
import type {
  PlanBlock,
  PlanPreview,
  ReplanPreview,
  WeekDay,
  WeekScheduleView,
} from "@/lib/planning/contract";
import { dateKey, formatTime, minuteOfDay } from "@/lib/time";

// ============================================================
// 智能日程（S4 + S5）
// 周视图：横向 周一 → 周日，纵向 08:00 → 22:00，CSS Grid / 绝对定位自绘。
// 课程 = 固定占用；正式计划 = 已确认日程；预览 = 虚线待确认块；
// 临时事件 = 一次性固定占用；冲突日程 = 红色危险状态。
// ============================================================

const DAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const WINDOW_START = 8 * 60;
const WINDOW_END = 22 * 60;
const SLOT_MINUTES = 30;
const SLOT_HEIGHT = 36;
const HOURS = Array.from({ length: 15 }, (_, index) => 8 + index);

type BlockKind = "COURSE" | "SCHEDULE" | "PREVIEW" | "EVENT";

interface SelectedBlock {
  kind: BlockKind;
  title: string;
  startAt: string;
  endAt: string;
  detail?: string | null;
  extra?: string | null;
  /** 正式计划块归属的任务 ID，用于打开决策解释抽屉（S7） */
  taskId?: string | null;
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
  EVENT: "border border-rose-300 bg-rose-100 text-rose-800 hover:bg-rose-200",
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

function todayDateInput(): string {
  const now = new Date();
  const p = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.getUTCFullYear()}-${pad(p.getUTCMonth() + 1)}-${pad(p.getUTCDate())}`;
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

  // S5：临时事件表单
  const [showEventForm, setShowEventForm] = useState(false);
  const [eventTitle, setEventTitle] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [eventStart, setEventStart] = useState("19:00");
  const [eventEnd, setEventEnd] = useState("20:30");
  const [eventLocation, setEventLocation] = useState("");
  const [creatingEvent, setCreatingEvent] = useState(false);

  // S5：冲突与重排
  const [replan, setReplan] = useState<ReplanPreview | null>(null);
  const [replanLoading, setReplanLoading] = useState(false);
  const [replanConfirming, setReplanConfirming] = useState(false);

  // S7：决策解释抽屉当前打开的任务 ID
  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null);

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

  const unresolvedConflicts = useMemo(
    () => (week?.conflicts ?? []).filter((c) => !c.resolved),
    [week],
  );
  const conflictScheduleIds = useMemo(
    () => new Set(unresolvedConflicts.map((c) => c.scheduleId)),
    [unresolvedConflicts],
  );

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

  // ------------------------------------------------------------
  // S5：创建临时事件
  // ------------------------------------------------------------
  async function handleCreateEvent() {
    if (!eventTitle.trim()) {
      setError("请填写事件标题");
      return;
    }
    if (!eventDate) {
      setError("请选择事件日期");
      return;
    }
    const startAt = new Date(`${eventDate}T${eventStart}:00+08:00`);
    const endAt = new Date(`${eventDate}T${eventEnd}:00+08:00`);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      setError("时间格式不正确");
      return;
    }
    setCreatingEvent(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/calendar-events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: eventTitle.trim(),
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
          location: eventLocation.trim() || null,
        }),
      });
      const data = (await response.json()) as {
        event?: { title: string };
        newConflicts?: number;
      } & ApiError;
      if (!response.ok) {
        throw new Error(data.error ?? "创建临时事件失败");
      }
      setShowEventForm(false);
      setEventTitle("");
      setEventLocation("");
      // 固定日程已变化：旧 preview 可能包含与新增事件重叠的块，立即作废
      const hadPreview = preview !== null;
      setPreview(null);
      setSelected(null);
      const n = data.newConflicts ?? 0;
      setNotice(
        hadPreview
          ? `已创建「${data.event?.title}」，固定日程已变化，请重新生成计划。`
          : n > 0
            ? `已创建「${data.event?.title}」，发现 ${n} 个计划冲突。`
            : `已创建「${data.event?.title}」，未发现冲突。`,
      );
      await refreshWeek();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreatingEvent(false);
    }
  }

  function fillDemoEvent() {
    // 快速填充一个会撞到现有任务的示例事件（真实保存 + 检测，不硬编码冲突结果）
    setEventTitle("学院创新讲座");
    setEventDate(todayDateInput());
    setEventStart("19:00");
    setEventEnd("20:30");
    setEventLocation("报告厅");
  }

  // ------------------------------------------------------------
  // S5：重排预览与确认
  // ------------------------------------------------------------
  async function handleReplanPreview() {
    setReplanLoading(true);
    setError(null);
    setNotice(null);
    setSelected(null);
    try {
      const response = await fetch("/api/schedule/replan-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await response.json()) as { preview?: ReplanPreview } & ApiError;
      if (!response.ok || !data.preview) {
        throw new Error(data.error ?? "生成重排预览失败");
      }
      setReplan(data.preview);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReplanLoading(false);
    }
  }

  async function handleReplanConfirm() {
    if (!replan) return;
    setReplanConfirming(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/schedule/replan-confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conflictIds: replan.conflictIds,
          blocks: replan.newBlocks,
          rangeStart: replan.rangeStart,
          rangeEnd: replan.rangeEnd,
        }),
      });
      const data = (await response.json()) as {
        cancelledCount?: number;
        createdCount?: number;
      } & ApiError;
      if (!response.ok) {
        throw new Error(data.error ?? "确认重排失败");
      }
      setReplan(null);
      setNotice(`已完成重排：取消 ${data.cancelledCount ?? 0} 条旧计划，新建 ${data.createdCount ?? 0} 条。`);
      await refreshWeek();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReplanConfirming(false);
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

  const replanNewByDate = useMemo(() => {
    const map = new Map<string, PlanBlock[]>();
    for (const block of replan?.newBlocks ?? []) {
      const key = dateKey(new Date(block.startAt));
      const list = map.get(key) ?? [];
      list.push(block);
      map.set(key, list);
    }
    return map;
  }, [replan]);

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
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setShowEventForm((v) => !v);
              setError(null);
            }}
            disabled={generating || confirming || replanLoading || replanConfirming}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            添加临时事件
          </button>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating || confirming || loading || replanLoading || replanConfirming}
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

      {/* S5：临时事件表单 */}
      {showEventForm && (
        <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-800">添加临时事件（一次性固定占用）</h2>
            <button
              type="button"
              onClick={fillDemoEvent}
              className="text-xs text-indigo-600 hover:underline"
            >
              快速填充示例
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-500">标题</span>
              <input
                value={eventTitle}
                onChange={(e) => setEventTitle(e.target.value)}
                placeholder="学院创新讲座"
                className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-500">日期</span>
              <input
                type="date"
                value={eventDate}
                onChange={(e) => setEventDate(e.target.value)}
                className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-500">开始</span>
              <input
                type="time"
                value={eventStart}
                onChange={(e) => setEventStart(e.target.value)}
                className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-500">结束</span>
              <input
                type="time"
                value={eventEnd}
                onChange={(e) => setEventEnd(e.target.value)}
                className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-500">地点（可选）</span>
              <input
                value={eventLocation}
                onChange={(e) => setEventLocation(e.target.value)}
                placeholder="报告厅"
                className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={handleCreateEvent}
              disabled={creatingEvent}
              className="rounded-md bg-rose-500 px-4 py-2 text-sm font-medium text-white transition disabled:opacity-50"
            >
              {creatingEvent ? "保存中…" : "保存并检测冲突"}
            </button>
            <button
              type="button"
              onClick={() => setShowEventForm(false)}
              className="rounded-md border border-slate-200 px-4 py-2 text-sm text-slate-500 hover:bg-slate-50"
            >
              取消
            </button>
          </div>
        </section>
      )}

      {/* S5：冲突横幅 */}
      {unresolvedConflicts.length > 0 && !replan && (
        <section className="rounded-lg border border-rose-300 bg-rose-50 p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-rose-800">
                当前发现 {unresolvedConflicts.length} 个未解决冲突
              </p>
              <p className="mt-1 text-xs text-rose-600">
                被影响的正式日程以红色高亮。点击下方条目可查看详情，点击「重新规划」生成替代方案。
              </p>
            </div>
            <button
              type="button"
              onClick={handleReplanPreview}
              disabled={replanLoading}
              className="shrink-0 rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white transition disabled:opacity-50"
            >
              {replanLoading ? "计算中…" : "重新规划"}
            </button>
          </div>
          <ul className="mt-3 flex flex-col gap-2">
            {unresolvedConflicts.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() =>
                    setSelected({
                      kind: "SCHEDULE",
                      title: c.scheduleTitle,
                      startAt: c.scheduleStartAt,
                      endAt: c.scheduleEndAt,
                      detail: c.description,
                      extra: "冲突",
                    })
                  }
                  className="w-full rounded-md border border-rose-200 bg-white px-3 py-2 text-left text-sm text-rose-800 hover:bg-rose-50"
                >
                  <span className="font-medium">冲突：</span>
                  {c.description}
                </button>
              </li>
            ))}
          </ul>
        </section>
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
          <span className="inline-block h-3 w-3 rounded-sm border border-rose-300 bg-rose-100" />
          临时事件
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm bg-rose-600" />
          冲突日程
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm border-2 border-dashed border-amber-500 bg-amber-100" />
          预览（未写入）
        </span>
        {preview && <span className="text-slate-400">策略：{preview.strategy}</span>}
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
                replanBlocks={replan ? replanNewByDate.get(day.dateKey) ?? [] : []}
                conflictScheduleIds={conflictScheduleIds}
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
                  : selected.kind === "EVENT"
                    ? "临时事件（固定占用）"
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
          {selected.kind === "SCHEDULE" && selected.taskId && (
            <button
              type="button"
              onClick={() => setDrawerTaskId(selected.taskId ?? null)}
              className="mt-3 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
            >
              为什么安排在这里？
            </button>
          )}
        </section>
      )}

      {/* S5：重排预览对比 */}
      {replan && (
        <section className="rounded-lg border border-rose-300 bg-rose-50/60 p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-rose-900">重排预览</h2>
              <p className="mt-1 text-xs text-rose-700">
                仅移动受冲突影响的 {replan.affectedOwners.length} 个对象；旧计划保留为已取消历史。
                确认后才会写入数据库。
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleReplanConfirm}
                disabled={replanConfirming || replan.newBlocks.length === 0}
                className="rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white transition disabled:opacity-50"
              >
                {replanConfirming ? "写入中…" : "确认重排"}
              </button>
              <button
                type="button"
                onClick={() => setReplan(null)}
                className="rounded-md border border-slate-200 bg-white px-4 py-2 text-sm text-slate-500 hover:bg-slate-50"
              >
                取消
              </button>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-md border border-slate-200 bg-white p-3">
              <p className="text-xs font-semibold text-slate-500">原计划（将标记为已取消）</p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {replan.oldBlocks.map((b) => (
                  <li key={b.scheduleId} className="rounded bg-slate-50 px-2 py-1.5 text-sm">
                    <span className="font-medium text-slate-800">{b.title}</span>
                    <span className="ml-2 text-xs text-slate-500">
                      {formatTime(new Date(b.startAt))}-{formatTime(new Date(b.endAt))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
              <p className="text-xs font-semibold text-emerald-700">建议新计划</p>
              {replan.newBlocks.length === 0 ? (
                <p className="mt-2 text-sm text-rose-700">无法重排：截止时间前剩余时间不足。</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1.5">
                  {replan.newBlocks.map((b) => (
                    <li key={b.clientId} className="rounded bg-white px-2 py-1.5 text-sm">
                      <button
                        type="button"
                        onClick={() =>
                          setSelected({
                            kind: "PREVIEW",
                            title: b.title,
                            startAt: b.startAt,
                            endAt: b.endAt,
                            detail: b.rationale,
                            extra: "重排建议",
                          })
                        }
                        className="text-left"
                      >
                        <span className="font-medium text-emerald-900">{b.title}</span>
                        <span className="ml-2 text-xs text-emerald-700">
                          {formatTime(new Date(b.startAt))}-{formatTime(new Date(b.endAt))}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {replan.unresolved.length > 0 && (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3">
              <p className="text-xs font-semibold text-amber-800">未能重排</p>
              <ul className="mt-1 flex flex-col gap-1">
                {replan.unresolved.map((u) => (
                  <li key={`${u.ownerType}-${u.ownerId}`} className="text-xs text-amber-800">
                    {u.title}：{u.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <UnscheduledPanel preview={preview} />

      <DecisionDrawer taskId={drawerTaskId} onClose={() => setDrawerTaskId(null)} />
    </main>
  );
}

function DayColumn({
  day,
  previewBlocks,
  replanBlocks,
  conflictScheduleIds,
  onSelect,
  selectedKey,
}: {
  day: WeekDay;
  previewBlocks: PlanBlock[];
  replanBlocks: PlanBlock[];
  conflictScheduleIds: Set<string>;
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

      {day.calendarEvents.map((event) => (
        <button
          key={event.id}
          type="button"
          onClick={() =>
            onSelect({
              kind: "EVENT",
              title: event.title,
              startAt: event.startAt,
              endAt: event.endAt,
              detail: event.location ? `地点：${event.location}` : "一次性固定占用，不可被排期引擎移动。",
              extra: event.location,
            })
          }
          className={`absolute left-1 right-1 overflow-hidden rounded-md px-1.5 py-1 text-left text-[11px] leading-tight transition ${KIND_STYLE.EVENT}`}
          style={{ top: topOf(event.startAt), height: heightOf(event.startAt, event.endAt) }}
        >
          <span className="block truncate font-medium">{event.title}</span>
          <span className="block truncate text-[10px] opacity-70">
            {formatTime(new Date(event.startAt))}-{formatTime(new Date(event.endAt))}
          </span>
          {event.location && (
            <span className="block truncate text-[10px] opacity-70">{event.location}</span>
          )}
        </button>
      ))}

      {day.schedules.map((schedule) => {
        const inConflict = conflictScheduleIds.has(schedule.id);
        return (
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
                extra: inConflict
                  ? "存在冲突"
                  : SCHEDULE_STATUS_LABELS[schedule.status] ?? schedule.status,
                taskId: schedule.taskId,
              })
            }
            className={`absolute left-1 right-1 overflow-hidden rounded-md px-1.5 py-1 text-left text-[11px] leading-tight transition ${
              inConflict
                ? "border-2 border-rose-600 bg-rose-600 text-white hover:bg-rose-700"
                : KIND_STYLE.SCHEDULE
            } ${selectedKey === schedule.startAt ? "ring-2 ring-slate-900 ring-offset-1" : ""}`}
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
        );
      })}

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

      {replanBlocks.map((block) => (
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
              extra: "重排建议",
            })
          }
          className={`absolute left-1 right-1 overflow-hidden rounded-md px-1.5 py-1 text-left text-[11px] leading-tight transition border-2 border-dashed border-emerald-500 bg-emerald-100/85 text-emerald-900 hover:bg-emerald-100`}
          style={{ top: topOf(block.startAt), height: heightOf(block.startAt, block.endAt) }}
        >
          <span className="block truncate font-medium">{block.title}</span>
          <span className="block truncate text-[10px] opacity-80">
            {formatTime(new Date(block.startAt))}-{formatTime(new Date(block.endAt))}
          </span>
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
