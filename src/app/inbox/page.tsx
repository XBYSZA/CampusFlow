"use client";

import { useMemo, useRef, useState } from "react";
import { DEMO_NOTICE } from "@/lib/fixtures/demo-notice";
import type { Evidence } from "@/lib/ai/contract";

// ============================================================
// Inbox 智能收件箱（S2）
// 粘贴通知 → Mock AI 结构化提取 → 原文证据高亮 → 编辑 → 确认入库
// ============================================================

type Phase = "idle" | "analyzing" | "extracted" | "confirming" | "confirmed";

interface EditableTask {
  title: string;
  description: string;
  /** datetime-local 输入值（YYYY-MM-DDTHH:mm），空字符串表示无截止 */
  deadlineLocal: string;
  priority: "low" | "medium" | "high";
  /** 用字符串承载输入，confirm 前再转 number 校验 */
  estimatedMinutes: string;
  evidence: Evidence[];
}

interface ConfirmResult {
  sourceId: string;
  taskCount: number;
}

const PRIORITY_OPTIONS = [
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" },
] as const;

const PRIORITY_BADGE: Record<EditableTask["priority"], string> = {
  high: "bg-red-100 text-red-700",
  medium: "bg-amber-100 text-amber-700",
  low: "bg-slate-100 text-slate-600",
};

function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface HighlightMark extends Evidence {
  key: string;
  active: boolean;
}

/** 将原文与 evidence 范围合成带高亮的分段（跳过重叠段，保证稳定渲染） */
function buildSegments(rawText: string, marks: HighlightMark[]) {
  const sorted = [...marks].sort((a, b) => a.start - b.start);
  const segments: Array<{ text: string; mark?: HighlightMark }> = [];
  let cursor = 0;
  for (const mark of sorted) {
    if (mark.start < cursor) continue; // 跳过重叠
    if (mark.start > cursor) segments.push({ text: rawText.slice(cursor, mark.start) });
    segments.push({ text: rawText.slice(mark.start, mark.end), mark });
    cursor = mark.end;
  }
  if (cursor < rawText.length) segments.push({ text: rawText.slice(cursor) });
  return segments;
}

export default function InboxPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [sourceTitle, setSourceTitle] = useState("");
  const [rawText, setRawText] = useState("");
  const [eventTitle, setEventTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [tasks, setTasks] = useState<EditableTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmResult, setConfirmResult] = useState<ConfirmResult | null>(null);
  const [activeEvidence, setActiveEvidence] = useState<{ task: number; ev: number } | null>(null);
  const [showEditor, setShowEditor] = useState(true);
  // 初始为空串保证预渲染确定性；在首次解析（事件处理器）中惰性生成一次性提交 ID
  const submissionIdRef = useRef<string>("");
  const highlightRefs = useRef(new Map<string, HTMLElement>());

  const analyzing = phase === "analyzing";
  const confirming = phase === "confirming";
  const extracted = phase === "extracted" || confirming || phase === "confirmed";

  const allMarks = useMemo<HighlightMark[]>(
    () =>
      tasks.flatMap((t, ti) =>
        t.evidence.map((ev, evi) => ({
          ...ev,
          key: `${ti}-${evi}`,
          active: activeEvidence?.task === ti && activeEvidence.ev === evi,
        })),
      ),
    [tasks, activeEvidence],
  );
  const segments = useMemo(
    () => (extracted ? buildSegments(rawText, allMarks) : []),
    [extracted, rawText, allMarks],
  );

  function loadDemo() {
    setSourceTitle(DEMO_NOTICE.title);
    setRawText(DEMO_NOTICE.rawText);
    resetResults();
  }

  function resetResults() {
    setPhase("idle");
    setEventTitle("");
    setSummary("");
    setTasks([]);
    setError(null);
    setConfirmResult(null);
    setActiveEvidence(null);
    setShowEditor(true);
    submissionIdRef.current = crypto.randomUUID();
  }

  function onRawTextChange(value: string) {
    setRawText(value);
    // 提取后若改动原文，旧的 evidence 偏移可能失效 → 清空结果重新解析
    if (phase !== "idle") resetResults();
  }

  async function runExtract() {
    if (!rawText.trim()) {
      setError("通知原文为空，请先粘贴或点击「加载演示通知」");
      return;
    }
    setError(null);
    setConfirmResult(null);
    if (!submissionIdRef.current) submissionIdRef.current = crypto.randomUUID();
    setPhase("analyzing");
    try {
      const res = await fetch("/api/inbox/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawText, sourceTitle: sourceTitle || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "解析失败");
      setEventTitle(data.eventTitle);
      setSummary(data.summary);
      setTasks(
        (data.tasks as Array<{
          title: string;
          description?: string;
          deadline: string | null;
          priority: EditableTask["priority"];
          estimatedMinutes: number;
          evidence: Evidence[];
        }>).map((t) => ({
          title: t.title,
          description: t.description ?? "",
          deadlineLocal: t.deadline ? isoToLocalInput(t.deadline) : "",
          priority: t.priority,
          estimatedMinutes: String(t.estimatedMinutes),
          evidence: t.evidence,
        })),
      );
      setPhase("extracted");
      setShowEditor(false);
    } catch (e) {
      setError((e as Error).message);
      setPhase("idle");
    }
  }

  function updateTask(index: number, patch: Partial<EditableTask>) {
    setTasks((prev) => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  }

  function focusEvidence(taskIndex: number, evIndex: number) {
    setActiveEvidence({ task: taskIndex, ev: evIndex });
    setShowEditor(false);
    requestAnimationFrame(() => {
      highlightRefs.current.get(`${taskIndex}-${evIndex}`)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });
  }

  async function runConfirm() {
    setError(null);
    // 前端预校验（服务端仍会完整复核）
    for (const t of tasks) {
      const minutes = Number(t.estimatedMinutes);
      if (!t.title.trim()) return setError("任务标题不能为空");
      if (!Number.isInteger(minutes) || minutes < 15 || minutes > 480)
        return setError(`任务「${t.title}」预计耗时须为 15~480 分钟的整数`);
    }
    setPhase("confirming");
    try {
      const res = await fetch("/api/inbox/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceTitle: sourceTitle.trim() || eventTitle,
          rawText,
          eventTitle,
          submissionId: submissionIdRef.current,
          tasks: tasks.map((t) => ({
            title: t.title.trim(),
            description: t.description.trim() || null,
            deadline: t.deadlineLocal ? new Date(t.deadlineLocal).toISOString() : null,
            priority: t.priority,
            estimatedMinutes: Number(t.estimatedMinutes),
            evidence: t.evidence,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "入库失败");
      setConfirmResult({ sourceId: data.sourceId, taskCount: data.taskCount });
      setPhase("confirmed");
    } catch (e) {
      setError((e as Error).message);
      setPhase("extracted");
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Inbox · 智能收件箱</h1>
        <p className="mt-1 text-sm text-slate-500">
          粘贴校园通知，AI 提取任务与截止时间，每条结论都可追溯到原文。
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 左栏：原文输入 / 高亮视图 */}
        <section className="flex flex-col gap-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <label className="mb-1 block text-sm font-medium text-slate-700">来源标题</label>
            <input
              value={sourceTitle}
              onChange={(e) => setSourceTitle(e.target.value)}
              placeholder="例如：2026 年校园数字创意挑战赛通知"
              className="mb-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
            />

            <div className="mb-1 flex items-center justify-between">
              <label className="text-sm font-medium text-slate-700">通知原文</label>
              {extracted && (
                <button
                  onClick={() => setShowEditor((v) => !v)}
                  className="text-xs text-slate-500 underline-offset-2 hover:underline"
                >
                  {showEditor ? "查看原文高亮" : "编辑原文"}
                </button>
              )}
            </div>

            {showEditor ? (
              <textarea
                value={rawText}
                onChange={(e) => onRawTextChange(e.target.value)}
                rows={16}
                placeholder="把课程群、比赛通知、活动公告粘贴到这里…"
                className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm leading-6 outline-none focus:border-slate-500"
              />
            ) : (
              <div className="max-h-[26rem] overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm leading-6 whitespace-pre-wrap">
                {segments.map((seg, i) =>
                  seg.mark ? (
                    <mark
                      key={seg.mark.key}
                      ref={(el) => {
                        if (el) highlightRefs.current.set(seg.mark!.key, el);
                      }}
                      className={
                        seg.mark.active
                          ? "rounded bg-amber-300 px-0.5 text-slate-900"
                          : "rounded bg-amber-100 px-0.5 text-slate-800"
                      }
                    >
                      {seg.text}
                    </mark>
                  ) : (
                    <span key={`t-${i}`}>{seg.text}</span>
                  ),
                )}
              </div>
            )}

            <div className="mt-3 flex gap-2">
              <button
                onClick={loadDemo}
                disabled={analyzing}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                加载演示通知
              </button>
              <button
                onClick={runExtract}
                disabled={analyzing || !rawText.trim()}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {analyzing ? "AI 正在分析…" : "AI 解析"}
              </button>
            </div>
            {!rawText.trim() && phase === "idle" && (
              <p className="mt-2 text-xs text-slate-400">输入为空：粘贴原文或加载演示通知后即可解析。</p>
            )}
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
          {phase === "confirmed" && confirmResult && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              入库成功：已创建 1 条来源与 {confirmResult.taskCount} 个任务（含决策日志）。
              <button
                onClick={() => {
                  setSourceTitle("");
                  setRawText("");
                  resetResults();
                }}
                className="ml-2 font-medium underline underline-offset-2"
              >
                解析下一条通知
              </button>
            </div>
          )}
        </section>

        {/* 右栏：AI 分析结果 */}
        <section className="flex flex-col gap-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-slate-700">AI 分析结果</h2>
              <span className="text-xs text-slate-400">
                {phase === "idle" && "等待输入"}
                {analyzing && "分析中…"}
                {phase === "extracted" && `已识别 ${tasks.length} 项任务`}
                {confirming && "正在入库…"}
                {phase === "confirmed" && "已入库"}
              </span>
            </div>

            {analyzing && (
              <div className="mt-4 flex items-center gap-3 rounded-lg bg-slate-50 px-4 py-6 text-sm text-slate-500">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
                AI 正在分析通知内容，提取任务与截止时间…
              </div>
            )}

            {phase === "idle" && !analyzing && (
              <p className="mt-4 rounded-lg bg-slate-50 px-4 py-6 text-sm text-slate-400">
                解析结果将展示在这里：事件标题、任务卡片与原文依据。
              </p>
            )}

            {extracted && (
              <div className="mt-4 flex flex-col gap-3">
                <div>
                  <p className="text-xs text-slate-400">识别事件</p>
                  <p className="text-base font-semibold text-slate-900">{eventTitle}</p>
                  <p className="mt-1 text-xs text-slate-500">{summary}</p>
                </div>

                {tasks.map((task, ti) => (
                  <div key={ti} className="rounded-lg border border-slate-200 p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <input
                        value={task.title}
                        onChange={(e) => updateTask(ti, { title: e.target.value })}
                        disabled={phase === "confirmed"}
                        className="w-full rounded-md border border-transparent px-2 py-1 text-sm font-medium text-slate-900 hover:border-slate-200 focus:border-slate-400 focus:outline-none"
                      />
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${PRIORITY_BADGE[task.priority]}`}
                      >
                        {PRIORITY_OPTIONS.find((o) => o.value === task.priority)?.label}优先级
                      </span>
                    </div>

                    <div className="mb-2 grid grid-cols-3 gap-2 text-xs">
                      <label className="flex flex-col gap-1 text-slate-500">
                        截止时间
                        <input
                          type="datetime-local"
                          value={task.deadlineLocal}
                          onChange={(e) => updateTask(ti, { deadlineLocal: e.target.value })}
                          disabled={phase === "confirmed"}
                          className="rounded-md border border-slate-200 px-2 py-1 text-slate-800 focus:border-slate-400 focus:outline-none"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-slate-500">
                        优先级
                        <select
                          value={task.priority}
                          onChange={(e) =>
                            updateTask(ti, { priority: e.target.value as EditableTask["priority"] })
                          }
                          disabled={phase === "confirmed"}
                          className="rounded-md border border-slate-200 px-2 py-1 text-slate-800 focus:border-slate-400 focus:outline-none"
                        >
                          {PRIORITY_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1 text-slate-500">
                        预计耗时（分钟）
                        <input
                          type="number"
                          min={15}
                          max={480}
                          step={15}
                          value={task.estimatedMinutes}
                          onChange={(e) => updateTask(ti, { estimatedMinutes: e.target.value })}
                          disabled={phase === "confirmed"}
                          className="rounded-md border border-slate-200 px-2 py-1 text-slate-800 focus:border-slate-400 focus:outline-none"
                        />
                      </label>
                    </div>

                    <textarea
                      value={task.description}
                      onChange={(e) => updateTask(ti, { description: e.target.value })}
                      rows={2}
                      disabled={phase === "confirmed"}
                      className="mb-2 w-full resize-y rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 focus:border-slate-400 focus:outline-none"
                    />

                    <div className="flex flex-wrap gap-1">
                      {task.evidence.map((_, evi) => (
                        <button
                          key={evi}
                          onClick={() => focusEvidence(ti, evi)}
                          className={`rounded-full border px-2 py-0.5 text-xs ${
                            activeEvidence?.task === ti && activeEvidence.ev === evi
                              ? "border-amber-400 bg-amber-100 text-amber-800"
                              : "border-slate-200 text-slate-500 hover:bg-slate-50"
                          }`}
                        >
                          查看原文依据 #{evi + 1}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}

                <button
                  onClick={runConfirm}
                  disabled={confirming || phase === "confirmed" || tasks.length === 0}
                  className="mt-1 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {confirming
                    ? "正在入库…"
                    : phase === "confirmed"
                      ? "已入库"
                      : `确认入库（${tasks.length} 个任务）`}
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
