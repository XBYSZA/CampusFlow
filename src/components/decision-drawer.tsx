"use client";

import { useEffect, useState } from "react";
import type {
  DecisionActor,
  DecisionStage,
  DecisionTimeline,
} from "@/lib/decision/contract";

// ============================================================
// 决策解释抽屉（S7）
// 右侧滑出，聚合展示 Source → EXTRACT → DECOMPOSE → PLAN → REPLAN。
// 所有内容来自服务端 DecisionTimeline（真实 DecisionLog / 数据库），
// 不调用 LLM 生成解释。
// ============================================================

const ACTOR_STYLE: Record<DecisionActor, { label: string; badge: string; dot: string }> = {
  AI: {
    label: "AI",
    badge: "bg-violet-100 text-violet-700",
    dot: "bg-violet-500",
  },
  RULE_ENGINE: {
    label: "规则引擎",
    badge: "bg-sky-100 text-sky-700",
    dot: "bg-sky-500",
  },
  HUMAN: {
    label: "人工确认",
    badge: "bg-emerald-100 text-emerald-700",
    dot: "bg-emerald-500",
  },
  SYSTEM: {
    label: "系统",
    badge: "bg-slate-100 text-slate-600",
    dot: "bg-slate-400",
  },
};

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  const p = new Date(d.getTime() + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.getUTCMonth() + 1}月${p.getUTCDate()}日 ${pad(p.getUTCHours())}:${pad(p.getUTCMinutes())}`;
}

interface DecisionDrawerProps {
  /** null 表示关闭 */
  taskId: string | null;
  onClose: () => void;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; timeline: DecisionTimeline };

export default function DecisionDrawer({ taskId, onClose }: DecisionDrawerProps) {
  // Esc 关闭
  useEffect(() => {
    if (!taskId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [taskId, onClose]);

  if (!taskId) return null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="决策解释">
      {/* 遮罩 */}
      <button
        type="button"
        aria-label="关闭决策解释"
        onClick={onClose}
        className="absolute inset-0 h-full w-full bg-slate-900/40 transition-opacity"
      />
      {/* 抽屉 */}
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col bg-white shadow-2xl sm:w-[36rem]">
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">决策解释</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              每个结论都能追溯：谁做的决定、依据是什么、是否经过你确认。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            关闭
          </button>
        </header>

        {/* 角色说明：评委能一眼看懂职责分工 */}
        <div className="flex flex-wrap gap-2 border-b border-slate-100 bg-slate-50/60 px-5 py-2.5 text-[11px] text-slate-600">
          <span className="flex items-center gap-1">
            <span className={`h-2 w-2 rounded-full ${ACTOR_STYLE.AI.dot}`} />
            AI：理解与拆解
          </span>
          <span className="flex items-center gap-1">
            <span className={`h-2 w-2 rounded-full ${ACTOR_STYLE.RULE_ENGINE.dot}`} />
            规则引擎：排期与重排
          </span>
          <span className="flex items-center gap-1">
            <span className={`h-2 w-2 rounded-full ${ACTOR_STYLE.HUMAN.dot}`} />
            你：确认每一步
          </span>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* key=taskId：切换任务时重新挂载，初始即为 loading，无需在 effect 中同步重置 */}
          <DrawerContent key={taskId} taskId={taskId} />
        </div>
      </aside>
    </div>
  );
}

function DrawerContent({ taskId }: { taskId: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/decisions/task/${taskId}`, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "加载决策解释失败");
        if (!cancelled) setState({ kind: "ready", timeline: data as DecisionTimeline });
      } catch (error) {
        if (!cancelled) setState({ kind: "error", message: (error as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  return (
    <>
      {state.kind === "loading" && (
        <div className="flex items-center gap-3 rounded-lg bg-slate-50 px-4 py-8 text-sm text-slate-500">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
          正在聚合决策记录…
        </div>
      )}

      {state.kind === "error" && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {state.message}
        </div>
      )}

      {state.kind === "ready" && <TimelineView timeline={state.timeline} />}
    </>
  );
}

function TimelineView({ timeline }: { timeline: DecisionTimeline }) {
  const { task, source, stages } = timeline;
  return (
    <div className="flex flex-col gap-4">
      {/* 任务与来源 */}
      <section className="rounded-lg border border-slate-200 p-3">
        <p className="text-sm font-semibold text-slate-900">{task.title}</p>
        <p className="mt-1 text-xs text-slate-500">
          {task.deadline ? `截止 ${fmtDateTime(task.deadline)}` : "无截止时间"}
          {task.estimatedMinutes ? ` · 预计 ${task.estimatedMinutes} 分钟` : ""}
        </p>
        {source ? (
          <div className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <p className="font-medium text-slate-700">信息来源：{source.title}</p>
            <p className="mt-0.5 text-slate-500">
              类型 {source.sourceType} · 捕获于 {fmtDateTime(source.capturedAt)}
            </p>
          </div>
        ) : (
          <p className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
            该任务为手动创建 / 无原始来源。
          </p>
        )}
      </section>

      {stages.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-400">
          暂无可解释决策记录
        </p>
      ) : (
        <ol className="relative flex flex-col gap-3 border-l-2 border-slate-200 pl-4">
          {stages.map((stage) => (
            <StageCard key={stage.id} stage={stage} />
          ))}
        </ol>
      )}
    </div>
  );
}

function StageCard({ stage }: { stage: DecisionStage }) {
  const actor = ACTOR_STYLE[stage.actor];
  return (
    <li className="relative rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <span
        className={`absolute -left-[1.42rem] top-4 h-2.5 w-2.5 rounded-full ring-4 ring-white ${actor.dot}`}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${actor.badge}`}>
          {actor.label}
        </span>
        <span className="text-sm font-medium text-slate-900">{stage.title}</span>
        <span className="ml-auto text-[11px] text-slate-400">{fmtDateTime(stage.timestamp)}</span>
      </div>

      <p className="mt-2 text-xs leading-5 text-slate-600">{stage.summary}</p>

      {stage.details.length > 0 && (
        <dl className="mt-2 flex flex-col gap-1.5">
          {stage.details.map((detail, index) => (
            <div key={index} className="rounded-md bg-slate-50 px-2.5 py-1.5 text-xs">
              <span className="font-medium text-slate-700">{detail.label}</span>
              <span className="mt-0.5 block leading-5 text-slate-600">{detail.value}</span>
            </div>
          ))}
        </dl>
      )}

      {stage.evidence.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] text-slate-400">AI 提取依据（原文可追溯）</p>
          <div className="mt-1 flex flex-col gap-1.5">
            {stage.evidence.map((item, index) => (
              <blockquote
                key={index}
                className="border-l-2 border-amber-300 bg-amber-50/60 px-2.5 py-1.5 text-xs"
              >
                <p className="text-slate-700">「{item.quote}」</p>
                {item.context && (
                  <p className="mt-0.5 text-[11px] leading-4 text-slate-400">
                    原文上下文：{item.context}
                  </p>
                )}
              </blockquote>
            ))}
          </div>
        </div>
      )}

      {stage.aiContext && (
        <p className="mt-2 text-[11px] text-slate-400">
          AI 调用上下文：provider={stage.aiContext.provider}
          {stage.aiContext.model ? ` · model=${stage.aiContext.model}` : ""}
          {stage.aiContext.promptVersion ? ` · Prompt v${stage.aiContext.promptVersion}` : ""}
          {typeof stage.aiContext.durationMs === "number"
            ? ` · ${(stage.aiContext.durationMs / 1000).toFixed(1)}s`
            : ""}
        </p>
      )}

      <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        {stage.confirmedNote}
      </p>
    </li>
  );
}
