"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AIMeta } from "@/lib/ai/contract";
import DecisionDrawer from "@/components/decision-drawer";

// ============================================================
// Tasks 任务板 + AI 拆解（S3 + S6）
// 左侧任务列表 → 右侧详情 → AI 拆解预览（Mock / 真实模型）→ 人工编辑 → 确认入库
// AI 只提出建议，确认后才写入正式数据
// ============================================================

interface TaskListItem {
  id: string;
  title: string;
  description: string | null;
  deadline: string | null;
  priority: string;
  status: string;
  estimatedMinutes: number | null;
  sourceTitle: string | null;
  subtaskCount: number;
}

interface SubTaskItem {
  id: string;
  title: string;
  estimatedMinutes: number | null;
  sortOrder: number;
  status: string;
  dependsOn: Array<{ id: string; title: string }>;
}

interface TaskDetail extends TaskListItem {
  source: { id: string; title: string } | null;
  evidenceQuotes: string[];
  subTasks: SubTaskItem[];
}

interface DraftSubTask {
  clientId: string;
  title: string;
  description: string;
  estimatedMinutes: string;
  sortOrder: number;
  dependsOn: string[];
}

type Phase =
  | "loadingList"
  | "listReady"
  | "loadingDetail"
  | "detailReady"
  | "decomposing"
  | "decomposed"
  | "confirming"
  | "confirmed"
  | "notFound";

const PRIORITY_LABEL: Record<string, string> = {
  HIGH: "高优先级",
  MEDIUM: "中优先级",
  LOW: "低优先级",
};
const PRIORITY_BADGE: Record<string, string> = {
  HIGH: "bg-red-100 text-red-700",
  MEDIUM: "bg-amber-100 text-amber-700",
  LOW: "bg-slate-100 text-slate-600",
};
const MIN_SUBTASK_MINUTES = 15;
const MAX_SUBTASK_MINUTES = 480;

function formatDeadline(iso: string | null): string {
  if (!iso) return "无截止时间";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function orderLabel(index: number): string {
  return ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"][index] ?? `${index + 1}.`;
}

export default function TasksPage() {
  const [phase, setPhase] = useState<Phase>("loadingList");
  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [drafts, setDrafts] = useState<DraftSubTask[]>([]);
  const [taskSummary, setTaskSummary] = useState("");
  // S6：本次拆解使用的 Provider 元信息（仅用于展示与决策留痕）
  const [aiMeta, setAiMeta] = useState<AIMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // S7：决策解释抽屉
  const [drawerOpen, setDrawerOpen] = useState(false);
  // S7.2：任务完成闭环
  const [completingTask, setCompletingTask] = useState(false);
  const [completingSubTaskId, setCompletingSubTaskId] = useState<string | null>(null);

  const loadDetail = useCallback(async (id: string) => {
    setPhase("loadingDetail");
    setDetail(null);
    setDrafts([]);
    setTaskSummary("");
    setAiMeta(null);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${id}`);
      const data = await res.json();
      if (res.status === 404) {
        setPhase("notFound");
        setError(data.error ?? "任务不存在");
        return;
      }
      if (!res.ok) throw new Error(data.error ?? "加载任务详情失败");
      setDetail(data as TaskDetail);
      setPhase("detailReady");
    } catch (e) {
      setError((e as Error).message);
      setPhase("notFound");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/tasks");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "加载任务列表失败");
        if (cancelled) return;
        const list = data.tasks as TaskListItem[];
        setTasks(list);
        setPhase("listReady");
        if (list.length > 0) {
          // 优先选中尚未拆解的任务，便于演示拆解流程
          const target = list.find((t) => t.subtaskCount === 0) ?? list[0];
          setSelectedId(target.id);
          void loadDetail(target.id);
        }
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setPhase("listReady");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadDetail]);

  const orderedDrafts = useMemo(
    () => [...drafts].sort((a, b) => a.sortOrder - b.sortOrder),
    [drafts],
  );

  function selectTask(id: string) {
    if (id === selectedId) return;
    setSelectedId(id);
    setSuccess(null);
    setDrawerOpen(false);
    void loadDetail(id);
  }

  /** 完成操作后刷新左侧列表的状态标签 */
  async function refreshTaskList() {
    try {
      const res = await fetch("/api/tasks");
      const data = await res.json();
      if (res.ok) setTasks(data.tasks as TaskListItem[]);
    } catch {
      // 列表刷新失败不影响完成结果本身
    }
  }

  async function handleCompleteTask() {
    if (!selectedId || completingTask) return;
    setCompletingTask(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`/api/tasks/${selectedId}/complete`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "标记完成失败");
      const message = data.alreadyCompleted
        ? "该任务已经是已完成状态。"
        : `任务「${data.title}」已完成${
            data.cancelledScheduleCount > 0
              ? `，并取消 ${data.cancelledScheduleCount} 个未来计划`
              : ""
          }。`;
      await loadDetail(selectedId);
      await refreshTaskList();
      setSuccess(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCompletingTask(false);
    }
  }

  async function handleCompleteSubTask(subTaskId: string) {
    if (!selectedId || completingSubTaskId) return;
    setCompletingSubTaskId(subTaskId);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`/api/subtasks/${subTaskId}/complete`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "完成执行步骤失败");
      const parts = [data.alreadyCompleted ? "该执行步骤已经是已完成状态" : `执行步骤「${data.title}」已完成`];
      if (data.parentAutoCompleted) parts.push("所有执行步骤均已完成，主任务同步完成");
      if (data.cancelledScheduleCount > 0) parts.push(`已取消 ${data.cancelledScheduleCount} 个未来计划`);
      await loadDetail(selectedId);
      await refreshTaskList();
      setSuccess(`${parts.join("；")}。`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCompletingSubTaskId(null);
    }
  }

  async function runDecompose() {
    if (!selectedId) return;
    setError(null);
    setSuccess(null);
    setPhase("decomposing");
    try {
      const res = await fetch(`/api/tasks/${selectedId}/decompose`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === "ALREADY_DECOMPOSED") {
          // 已拆解 → 回到详情展示正式子任务，不再提供拆解入口
          await loadDetail(selectedId);
          setError(data.error);
          return;
        }
        throw new Error(data.error ?? "AI 拆解失败");
      }
      const subtasks = data.subtasks as Array<{
        clientId: string;
        title: string;
        description?: string;
        estimatedMinutes: number;
        sortOrder: number;
        dependsOn: string[];
      }>;
      setTaskSummary(data.taskSummary);
      setAiMeta((data.aiMeta as AIMeta | undefined) ?? null);
      setDrafts(
        subtasks.map((s) => ({
          clientId: s.clientId,
          title: s.title,
          description: s.description ?? "",
          estimatedMinutes: String(s.estimatedMinutes),
          sortOrder: s.sortOrder,
          dependsOn: s.dependsOn,
        })),
      );
      setPhase("decomposed");
    } catch (e) {
      setError((e as Error).message);
      setPhase("detailReady");
    }
  }

  function updateDraft(index: number, patch: Partial<DraftSubTask>) {
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }

  async function runConfirm() {
    if (!selectedId) return;
    setError(null);
    for (const d of orderedDrafts) {
      const minutes = Number(d.estimatedMinutes);
      if (!d.title.trim()) return setError("子任务标题不能为空");
      if (!Number.isInteger(minutes) || minutes < MIN_SUBTASK_MINUTES || minutes > MAX_SUBTASK_MINUTES)
        return setError(`子任务「${d.title}」预计耗时须为 ${MIN_SUBTASK_MINUTES}~${MAX_SUBTASK_MINUTES} 分钟的整数`);
    }
    setPhase("confirming");
    try {
      const res = await fetch(`/api/tasks/${selectedId}/confirm-decomposition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subtasks: orderedDrafts.map((d) => ({
            clientId: d.clientId,
            title: d.title.trim(),
            description: d.description.trim() || undefined,
            estimatedMinutes: Number(d.estimatedMinutes),
            sortOrder: d.sortOrder,
            dependsOn: d.dependsOn,
          })),
          aiMeta: aiMeta ?? undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === "ALREADY_DECOMPOSED") {
          await loadDetail(selectedId);
        }
        throw new Error(data.error ?? "确认拆解失败");
      }
      setSuccess(`已写入 ${data.subtaskIds.length} 个子任务、${data.dependencyCount} 条依赖关系`);
      setDrafts([]);
      await loadDetail(selectedId);
      // 刷新左侧列表的拆解状态
      const listRes = await fetch("/api/tasks");
      if (listRes.ok) {
        const listData = await listRes.json();
        setTasks(listData.tasks as TaskListItem[]);
      }
    } catch (e) {
      setError((e as Error).message);
      setPhase("decomposed");
    }
  }

  const busy = phase === "loadingList" || phase === "decomposing" || phase === "confirming";
  const hasFormalSubTasks = (detail?.subTasks.length ?? 0) > 0;

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Tasks · 任务板</h1>
        <p className="mt-1 text-sm text-slate-500">
          查看收件箱提取的任务，用 AI 拆成可执行步骤；拆解结果由你确认后才入库。
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        {/* 左栏：任务列表 */}
        <aside className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-slate-700">任务列表</h2>

          {phase === "loadingList" && (
            <div className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-sm text-slate-400">
              正在加载任务…
            </div>
          )}

          {phase !== "loadingList" && tasks.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-sm text-slate-400">
              暂无任务。请先到 Inbox 解析并入库一条校园通知。
            </div>
          )}

          {tasks.map((task) => {
            const active = task.id === selectedId;
            return (
              <button
                key={task.id}
                onClick={() => selectTask(task.id)}
                className={`rounded-lg border px-3 py-2 text-left transition ${
                  active
                    ? "border-slate-900 bg-white shadow-sm"
                    : "border-slate-200 bg-white hover:border-slate-400"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium text-slate-900">{task.title}</span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
                      PRIORITY_BADGE[task.priority] ?? PRIORITY_BADGE.MEDIUM
                    }`}
                  >
                    {PRIORITY_LABEL[task.priority] ?? task.priority}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500">{formatDeadline(task.deadline)}</p>
                <div className="mt-1 flex items-center justify-between text-[11px] text-slate-400">
                  <span className="truncate">{task.sourceTitle ?? "手动创建"}</span>
                  <span>
                    {task.status === "DONE"
                      ? "已完成"
                      : task.subtaskCount > 0
                        ? `已拆解 ${task.subtaskCount} 项`
                        : "待拆解"}
                  </span>
                </div>
              </button>
            );
          })}
        </aside>

        {/* 右栏：任务详情 */}
        <section className="flex flex-col gap-3">
          {phase === "loadingDetail" && (
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400">
              正在加载任务详情…
            </div>
          )}

          {phase === "notFound" && (
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-500">
              {error ?? "任务不存在"}
            </div>
          )}

          {detail && phase !== "notFound" && (
            <>
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-slate-900">{detail.title}</h2>
                    <p className="mt-1 text-xs text-slate-500">
                      {detail.sourceTitle ?? "手动创建"} · {formatDeadline(detail.deadline)} · 预计{" "}
                      {detail.estimatedMinutes ?? "未设置"} 分钟
                    </p>
                    <button
                      type="button"
                      onClick={() => setDrawerOpen(true)}
                      className="mt-2 rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:border-slate-400 hover:bg-slate-50"
                    >
                      查看决策解释
                    </button>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        PRIORITY_BADGE[detail.priority] ?? PRIORITY_BADGE.MEDIUM
                      }`}
                    >
                      {PRIORITY_LABEL[detail.priority] ?? detail.priority}
                    </span>
                    {detail.status === "DONE" ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                        已完成
                      </span>
                    ) : detail.subTasks.length > 0 ? (
                      <span className="text-[11px] text-slate-400">完成全部执行步骤后自动完成</span>
                    ) : (
                      <button
                        type="button"
                        onClick={handleCompleteTask}
                        disabled={completingTask || busy || phase !== "detailReady"}
                        className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {completingTask ? "处理中…" : "标记完成"}
                      </button>
                    )}
                  </div>
                </div>

                {detail.description && (
                  <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-600">
                    {detail.description}
                  </p>
                )}

                {detail.evidenceQuotes.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs text-slate-400">来源依据</p>
                    <div className="mt-1 flex flex-col gap-1">
                      {detail.evidenceQuotes.map((quote, i) => (
                        <p
                          key={i}
                          className="border-l-2 border-amber-300 bg-amber-50/60 px-2 py-1 text-xs text-slate-600"
                        >
                          「{quote}」
                        </p>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {error}
                </div>
              )}
              {success && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                  {success}
                </div>
              )}

              {/* 已拆解：展示正式子任务 */}
              {hasFormalSubTasks && (
                <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-medium text-slate-700">子任务（已拆解）</h3>
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-700">
                      已入库
                    </span>
                  </div>
                  <ol className="flex flex-col gap-2">
                    {detail.subTasks.map((st, index) => (
                      <li key={st.id} className="rounded-lg border border-slate-200 px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm text-slate-900">
                            <span className="mr-1 text-slate-400">{orderLabel(index)}</span>
                            {st.title}
                          </span>
                          <div className="flex shrink-0 items-center gap-2">
                            <span className="text-xs text-slate-500">
                              {st.estimatedMinutes ?? "—"} 分钟
                            </span>
                            {st.status === "DONE" ? (
                              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-700">
                                已完成
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleCompleteSubTask(st.id)}
                                disabled={completingSubTaskId !== null}
                                className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {completingSubTaskId === st.id ? "处理中…" : "完成"}
                              </button>
                            )}
                          </div>
                        </div>
                        {st.dependsOn.length > 0 && (
                          <p className="mt-1 text-[11px] text-slate-400">
                            依赖：
                            {st.dependsOn
                              .map(
                                (dep) =>
                                  `${orderLabel(detail.subTasks.findIndex((s) => s.id === dep.id))} ${dep.title}`,
                              )
                              .join("、")}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                  <p className="mt-3 text-[11px] text-slate-400">
                    该任务已拆解，S3 不支持重复拆解或覆盖已有子任务。
                  </p>
                </div>
              )}

              {/* 未拆解：拆解入口 */}
              {!hasFormalSubTasks && drafts.length === 0 && (
                <div className="rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
                  <p className="text-sm text-slate-500">尚未拆解</p>
                  <button
                    onClick={runDecompose}
                    disabled={busy}
                    className="mt-3 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    AI 拆解任务
                  </button>
                </div>
              )}

              {phase === "decomposing" && (
                <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-8 text-sm text-slate-500 shadow-sm">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
                  AI 正在分析任务并生成执行步骤…
                </div>
              )}

              {/* 拆解预览：可编辑 */}
              {drafts.length > 0 && (
                <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-medium text-slate-700">AI 拆解结果（待确认）</h3>
                    <span className="text-[11px] text-slate-400">可修改标题、耗时与依赖</span>
                  </div>
                  {taskSummary && <p className="mb-3 text-xs text-slate-500">{taskSummary}</p>}
                  {aiMeta && (
                    <p className="mb-3 text-[11px] text-slate-400">
                      {aiMeta.provider === "mock"
                        ? "开发模式：Mock AI"
                        : `AI 模型：${aiMeta.model ?? "unknown"}`}
                      {` · Prompt v${aiMeta.promptVersion}`}
                      {typeof aiMeta.durationMs === "number"
                        ? ` · ${(aiMeta.durationMs / 1000).toFixed(1)}s`
                        : ""}
                    </p>
                  )}

                  <div className="flex flex-col gap-2">
                    {orderedDrafts.map((draft, index) => {
                      const originIndex = drafts.findIndex((d) => d.clientId === draft.clientId);
                      return (
                        <div key={draft.clientId} className="rounded-lg border border-slate-200 p-3">
                          <div className="flex items-center gap-2">
                            <span className="shrink-0 text-sm text-slate-400">{orderLabel(index)}</span>
                            <input
                              value={draft.title}
                              onChange={(e) =>
                                updateDraft(originIndex, { title: e.target.value })
                              }
                              className="w-full rounded-md border border-transparent px-2 py-1 text-sm font-medium text-slate-900 hover:border-slate-200 focus:border-slate-400 focus:outline-none"
                            />
                            <div className="flex shrink-0 items-center gap-1">
                              <input
                                type="number"
                                min={MIN_SUBTASK_MINUTES}
                                max={MAX_SUBTASK_MINUTES}
                                step={15}
                                value={draft.estimatedMinutes}
                                onChange={(e) =>
                                  updateDraft(originIndex, { estimatedMinutes: e.target.value })
                                }
                                className="w-20 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-800 focus:border-slate-400 focus:outline-none"
                              />
                              <span className="text-xs text-slate-400">分钟</span>
                            </div>
                          </div>

                          {draft.description && (
                            <p className="mt-1 pl-6 text-xs text-slate-500">{draft.description}</p>
                          )}

                          <div className="mt-2 flex items-center gap-2 pl-6">
                            <span className="text-[11px] text-slate-400">依赖</span>
                            <select
                              value={draft.dependsOn[0] ?? ""}
                              onChange={(e) =>
                                updateDraft(originIndex, {
                                  dependsOn: e.target.value ? [e.target.value] : [],
                                })
                              }
                              className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-700 focus:border-slate-400 focus:outline-none"
                            >
                              <option value="">无（可并行）</option>
                              {orderedDrafts
                                .filter((other) => other.clientId !== draft.clientId)
                                .map((other) => (
                                  <option key={other.clientId} value={other.clientId}>
                                    {orderLabel(orderedDrafts.indexOf(other))} {other.title}
                                  </option>
                                ))}
                            </select>
                            {draft.dependsOn.length > 0 &&
                              !orderedDrafts.some((d) => d.clientId === draft.dependsOn[0]) && (
                                <span className="text-[11px] text-red-500">
                                  依赖已失效，请重新选择
                                </span>
                              )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={runConfirm}
                      disabled={busy}
                      className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {phase === "confirming" ? "正在入库…" : "确认拆解"}
                    </button>
                    <button
                      onClick={() => {
                        setDrafts([]);
                        setTaskSummary("");
                        setError(null);
                      }}
                      disabled={phase === "confirming"}
                      className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      放弃
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <DecisionDrawer
        taskId={drawerOpen && selectedId ? selectedId : null}
        onClose={() => setDrawerOpen(false)}
      />
    </main>
  );
}
