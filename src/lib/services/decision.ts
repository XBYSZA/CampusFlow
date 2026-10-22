import { prisma } from "@/lib/prisma";
import {
  decisionTimelineSchema,
  type AICallContext,
  type DecisionActor,
  type DecisionDetail,
  type DecisionEvidenceItem,
  type DecisionStage,
  type DecisionStageType,
  type DecisionTimeline,
} from "@/lib/decision/contract";

// ============================================================
// 决策解释聚合服务（S7）
//
// 把一个 Task 关联的 Source / DecisionLog / SubTask / Schedule /
// Conflict 聚合成统一的 DecisionTimeline，供决策解释抽屉展示。
//
// 原则：
// - 只读数据库中已存在的决策记录，不重新调用 LLM 生成解释
// - 某阶段不存在就跳过，不报错、不伪造
// - aiContext 仅从 DecisionLog.inputSummary 中尽力解析，
//   作为「AI 调用上下文」展示，不是审计证据
// ============================================================

export class DecisionError extends Error {
  constructor(
    public readonly code: "TASK_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "DecisionError";
  }
}

const CONFIRMED_NOTE = "该结果经用户确认后写入正式数据。";

const STAGE_META: Record<DecisionStageType, { title: string; actor: DecisionActor }> = {
  EXTRACT: { title: "从原始通知中识别任务", actor: "AI" },
  DECOMPOSE: { title: "将复杂任务拆解为执行步骤", actor: "AI" },
  PLAN: { title: "确定性规则引擎生成执行计划", actor: "RULE_ENGINE" },
  REPLAN: { title: "冲突触发的自动重排", actor: "RULE_ENGINE" },
  // COMPLETE 由用户主动触发，标题按完成对象在 mapCompleteStage 中细分
  COMPLETE: { title: "任务完成", actor: "HUMAN" },
};

const COMPLETE_NOTE = "由用户主动完成，结果直接写入正式数据。";

const ORDER_LABELS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];

function orderLabel(index: number): string {
  return ORDER_LABELS[index] ?? `${index + 1}.`;
}

/** 与 schedule 页一致的上海时区格式化：10月23日 08:00 */
function fmtDateTime(iso: string | Date): string {
  const d = new Date(iso);
  const p = new Date(d.getTime() + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.getUTCMonth() + 1}月${p.getUTCDate()}日 ${pad(p.getUTCHours())}:${pad(p.getUTCMinutes())}`;
}

/** 从 inputSummary 中尽力解析 AI 调用上下文（mock 早期日志可能没有） */
function parseAiContext(inputSummary: string): AICallContext | null {
  const provider = inputSummary.match(/AI provider=([a-z]+)/)?.[1];
  if (!provider) return null;
  const model = inputSummary.match(/model=([^；]+)/)?.[1] ?? null;
  const promptVersion = inputSummary.match(/promptVersion=([^；]+)/)?.[1] ?? null;
  const durationText = inputSummary.match(/耗时 (\d+)ms/)?.[1];
  return {
    provider,
    model,
    promptVersion,
    durationMs: durationText ? Number(durationText) : null,
  };
}

function safeParse(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** 截取 quote 在原文中的上下文，便于用户对照；定位失败返回 null */
function contextOf(
  rawText: string | null,
  quote: string,
  start: unknown,
  end: unknown,
): string | null {
  if (!rawText) return null;
  let s = typeof start === "number" && Number.isInteger(start) ? start : -1;
  if (s >= 0 && rawText.slice(s, s + quote.length) !== quote) s = -1;
  if (s < 0) {
    const first = rawText.indexOf(quote);
    if (first < 0 || rawText.indexOf(quote, first + 1) >= 0) return null;
    s = first;
  }
  void end;
  const from = Math.max(0, s - 30);
  const to = Math.min(rawText.length, s + quote.length + 30);
  const prefix = from > 0 ? "…" : "";
  const suffix = to < rawText.length ? "…" : "";
  return `${prefix}${rawText.slice(from, to)}${suffix}`;
}

// ------------------------------------------------------------
// 各阶段映射
// ------------------------------------------------------------

function mapExtractStage(
  log: { id: string; createdAt: Date; outputSummary: string; inputSummary: string; evidence: string | null },
  task: { title: string; deadline: Date | null; priority: string; estimatedMinutes: number | null },
  rawText: string | null,
): DecisionStage {
  const raw = safeParse(log.evidence);
  const items: DecisionEvidenceItem[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const quote = (entry as { quote?: unknown }).quote;
      if (typeof quote !== "string" || !quote) continue;
      items.push({
        quote,
        field: typeof (entry as { field?: unknown }).field === "string"
          ? ((entry as { field: string }).field)
          : null,
        context: contextOf(
          rawText,
          quote,
          (entry as { start?: unknown }).start,
          (entry as { end?: unknown }).end,
        ),
      });
    }
  }

  const details: DecisionDetail[] = [
    { label: "识别任务", value: task.title },
    {
      label: "截止时间",
      value: task.deadline ? fmtDateTime(task.deadline) : "无明确截止时间",
    },
    { label: "优先级", value: task.priority },
    {
      label: "预计耗时",
      value: task.estimatedMinutes ? `${task.estimatedMinutes} 分钟` : "未估算",
    },
  ];

  const meta = STAGE_META.EXTRACT;
  return {
    id: log.id,
    type: "EXTRACT",
    title: meta.title,
    actor: meta.actor,
    timestamp: log.createdAt.toISOString(),
    summary: log.outputSummary,
    details,
    evidence: items,
    aiContext: parseAiContext(log.inputSummary),
    confirmedNote: CONFIRMED_NOTE,
  };
}

function mapDecomposeStage(log: {
  id: string;
  createdAt: Date;
  outputSummary: string;
  inputSummary: string;
  evidence: string | null;
}): DecisionStage {
  const raw = safeParse(log.evidence) as {
    subtasks?: Array<{
      clientId?: string;
      title?: string;
      estimatedMinutes?: number;
      sortOrder?: number;
      dependsOn?: string[];
    }>;
  } | null;

  const details: DecisionDetail[] = [];
  if (raw?.subtasks && Array.isArray(raw.subtasks)) {
    const sorted = [...raw.subtasks].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const labelOf = new Map<string, string>();
    sorted.forEach((sub, index) => {
      if (sub.clientId) labelOf.set(sub.clientId, `${orderLabel(index)} ${sub.title ?? ""}`);
    });
    sorted.forEach((sub, index) => {
      const deps = (sub.dependsOn ?? [])
        .map((clientId) => labelOf.get(clientId) ?? clientId)
        .join("、");
      details.push({
        label: `${orderLabel(index)} ${sub.title ?? "未命名步骤"}`,
        value: `预计 ${sub.estimatedMinutes ?? "—"} 分钟${deps ? `；依赖：${deps}` : "；无前置依赖"}`,
      });
    });
  }

  const meta = STAGE_META.DECOMPOSE;
  return {
    id: log.id,
    type: "DECOMPOSE",
    title: meta.title,
    actor: meta.actor,
    timestamp: log.createdAt.toISOString(),
    summary: log.outputSummary,
    details,
    evidence: [],
    aiContext: parseAiContext(log.inputSummary),
    confirmedNote: CONFIRMED_NOTE,
  };
}

function mapPlanStage(log: {
  id: string;
  createdAt: Date;
  outputSummary: string;
  evidence: string | null;
}): DecisionStage {
  const raw = safeParse(log.evidence) as {
    strategy?: string;
    blocks?: Array<{ title?: string; startAt?: string; endAt?: string; rationale?: string }>;
    unscheduled?: Array<{ title?: string; reason?: string }>;
  } | null;

  const details: DecisionDetail[] = [];
  if (raw?.strategy) details.push({ label: "排期策略", value: raw.strategy });
  for (const block of raw?.blocks ?? []) {
    if (!block.startAt || !block.endAt) continue;
    details.push({
      label: block.title ?? "计划块",
      value: `${fmtDateTime(block.startAt)} → ${fmtDateTime(block.endAt)}${
        block.rationale ? `｜依据：${block.rationale}` : ""
      }`,
    });
  }
  for (const item of raw?.unscheduled ?? []) {
    details.push({
      label: `未安排·${item.title ?? "未知对象"}`,
      value: item.reason ?? "未找到合法时段",
    });
  }

  const meta = STAGE_META.PLAN;
  return {
    id: log.id,
    type: "PLAN",
    title: meta.title,
    actor: meta.actor,
    timestamp: log.createdAt.toISOString(),
    summary: log.outputSummary,
    details,
    evidence: [],
    aiContext: null,
    confirmedNote: CONFIRMED_NOTE,
  };
}

interface ScheduleRow {
  id: string;
  title: string | null;
  startAt: Date;
  endAt: Date;
  status: string;
  rationale: string | null;
  taskId: string | null;
  subTaskId: string | null;
}

function mapReplanStage(
  log: { id: string; createdAt: Date; outputSummary: string; evidence: string | null },
  schedulesById: Map<string, ScheduleRow>,
  conflictsById: Map<
    string,
    {
      id: string;
      description: string;
      resolution: string | null;
      resolvedAt: Date | null;
      courseTitle: string | null;
      eventTitle: string | null;
    }
  >,
): DecisionStage {
  const raw = safeParse(log.evidence) as {
    strategy?: string;
    conflictIds?: string[];
    cancelledScheduleIds?: string[];
    newScheduleIds?: string[];
  } | null;

  const details: DecisionDetail[] = [];
  for (const conflictId of raw?.conflictIds ?? []) {
    const conflict = conflictsById.get(conflictId);
    if (!conflict) continue;
    details.push({ label: "触发冲突", value: conflict.description });
    const fixed = conflict.eventTitle ?? conflict.courseTitle;
    if (fixed) details.push({ label: "固定占用方", value: fixed });
  }

  // old → new 对照：旧计划保留为 CANCELLED 历史，新计划为 CONFIRMED
  for (const oldId of raw?.cancelledScheduleIds ?? []) {
    const old = schedulesById.get(oldId);
    if (!old) continue;
    details.push({
      label: `原计划·${old.title ?? "未命名日程"}`,
      value: `${fmtDateTime(old.startAt)} → ${fmtDateTime(old.endAt)}（已取消，保留历史）`,
    });
  }
  for (const newId of raw?.newScheduleIds ?? []) {
    const fresh = schedulesById.get(newId);
    if (!fresh) continue;
    details.push({
      label: `新计划·${fresh.title ?? "未命名日程"}`,
      value: `${fmtDateTime(fresh.startAt)} → ${fmtDateTime(fresh.endAt)}（已确认）${
        fresh.rationale ? `｜依据：${fresh.rationale}` : ""
      }`,
    });
  }
  if (raw?.strategy) details.push({ label: "重排策略", value: raw.strategy });

  const meta = STAGE_META.REPLAN;
  return {
    id: log.id,
    type: "REPLAN",
    title: meta.title,
    actor: meta.actor,
    timestamp: log.createdAt.toISOString(),
    summary: log.outputSummary,
    details,
    evidence: [],
    aiContext: null,
    confirmedNote: CONFIRMED_NOTE,
  };
}

interface CompleteLogEvidence {
  ownerType?: string;
  title?: string;
  status?: string;
  cancelledScheduleCount?: number;
  cancelledScheduleIds?: string[];
  parentAutoCompleted?: boolean;
}

function mapCompleteStage(log: {
  id: string;
  createdAt: Date;
  outputSummary: string;
  evidence: string | null;
}): DecisionStage {
  const raw = (safeParse(log.evidence) ?? {}) as CompleteLogEvidence;
  const isTask = raw.ownerType === "TASK";
  const ownerLabel = isTask ? "任务" : "执行步骤";
  const cancelledCount =
    typeof raw.cancelledScheduleCount === "number"
      ? raw.cancelledScheduleCount
      : Array.isArray(raw.cancelledScheduleIds)
        ? raw.cancelledScheduleIds.length
        : 0;

  const details: DecisionDetail[] = [
    { label: "完成对象", value: `${ownerLabel}「${raw.title ?? "未命名"}」` },
    { label: "状态", value: raw.status === "DONE" || !raw.status ? "DONE（已完成）" : raw.status },
    {
      label: "未来计划",
      value: cancelledCount > 0 ? `已取消 ${cancelledCount} 个未来计划` : "没有需要取消的未来计划",
    },
  ];
  if (raw.parentAutoCompleted) {
    details.push({
      label: "主任务联动",
      value: "所有执行步骤均已完成，主任务同步完成",
    });
  }

  const meta = STAGE_META.COMPLETE;
  return {
    id: log.id,
    type: "COMPLETE",
    title: isTask ? "任务完成" : "执行步骤完成",
    actor: meta.actor,
    timestamp: log.createdAt.toISOString(),
    summary: log.outputSummary,
    details,
    evidence: [],
    aiContext: null,
    confirmedNote: COMPLETE_NOTE,
  };
}

// ------------------------------------------------------------
// 聚合入口
// ------------------------------------------------------------

export async function buildDecisionTimeline(taskId: string): Promise<DecisionTimeline> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      source: true,
      decisionLogs: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!task) {
    throw new DecisionError("TASK_NOT_FOUND", `任务不存在：${taskId}`);
  }

  // 收集 REPLAN 日志引用的 Schedule / Conflict ID，一次性加载
  const scheduleIds = new Set<string>();
  const conflictIds = new Set<string>();
  for (const log of task.decisionLogs) {
    if (log.actionType !== "REPLAN") continue;
    const raw = safeParse(log.evidence) as {
      conflictIds?: string[];
      cancelledScheduleIds?: string[];
      newScheduleIds?: string[];
    } | null;
    for (const id of raw?.cancelledScheduleIds ?? []) scheduleIds.add(id);
    for (const id of raw?.newScheduleIds ?? []) scheduleIds.add(id);
    for (const id of raw?.conflictIds ?? []) conflictIds.add(id);
  }

  const [scheduleRows, conflictRows] = await Promise.all([
    scheduleIds.size > 0
      ? prisma.schedule.findMany({
          where: { id: { in: [...scheduleIds] } },
          include: {
            task: { select: { title: true } },
            subTask: { select: { title: true } },
          },
        })
      : Promise.resolve([]),
    conflictIds.size > 0
      ? prisma.conflict.findMany({
          where: { id: { in: [...conflictIds] } },
          include: {
            course: { select: { title: true } },
            calendarEvent: { select: { title: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  const schedulesById = new Map<string, ScheduleRow>(
    scheduleRows.map((row) => [
      row.id,
      {
        id: row.id,
        title: row.subTask?.title ?? row.task?.title ?? null,
        startAt: row.startAt,
        endAt: row.endAt,
        status: row.status,
        rationale: row.rationale,
        taskId: row.taskId,
        subTaskId: row.subTaskId,
      },
    ]),
  );
  const conflictsById = new Map(
    conflictRows.map((row) => [
      row.id,
      {
        id: row.id,
        description: row.description,
        resolution: row.resolution,
        resolvedAt: row.resolvedAt,
        courseTitle: row.course?.title ?? null,
        eventTitle: row.calendarEvent?.title ?? null,
      },
    ]),
  );

  const stages: DecisionStage[] = [];
  for (const log of task.decisionLogs) {
    switch (log.actionType) {
      case "EXTRACT":
        stages.push(mapExtractStage(log, task, task.source?.rawText ?? null));
        break;
      case "DECOMPOSE":
        stages.push(mapDecomposeStage(log));
        break;
      case "PLAN":
        stages.push(mapPlanStage(log));
        break;
      case "REPLAN":
        stages.push(mapReplanStage(log, schedulesById, conflictsById));
        break;
      case "COMPLETE":
        stages.push(mapCompleteStage(log));
        break;
      default:
        // 未知类型不展示，避免破坏整个时间线
        break;
    }
  }

  return decisionTimelineSchema.parse({
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      deadline: task.deadline?.toISOString() ?? null,
      priority: task.priority,
      estimatedMinutes: task.estimatedMinutes,
      status: task.status,
    },
    source: task.source
      ? {
          id: task.source.id,
          title: task.source.title,
          sourceType: task.source.sourceType,
          capturedAt: task.source.capturedAt.toISOString(),
        }
      : null,
    stages,
  });
}
