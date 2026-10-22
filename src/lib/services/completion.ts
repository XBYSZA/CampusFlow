import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

// ============================================================
// 任务完成闭环（S7.2）
//
// 语义：
// - 无 SubTask 的 Task 可由用户直接标记完成
// - 有 SubTask 的 Task 不允许在仍有未完成子任务时直接完成；
//   子任务逐个完成后，最后一个完成时自动把父 Task 置为 DONE
// - 完成时在同一事务内：status → DONE、取消该 owner 未来的有效 Schedule、
//   写入 COMPLETE DecisionLog
// - 过去的 Schedule 保留原状态作为历史；不删除任何数据
// - 已完成对象再次完成：幂等返回，不重复产生副作用
// ============================================================

export type CompleteErrorCode =
  | "TASK_NOT_FOUND"
  | "SUBTASK_NOT_FOUND"
  | "TASK_HAS_INCOMPLETE_SUBTASKS";

export class CompleteError extends Error {
  constructor(
    public readonly code: CompleteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CompleteError";
  }
}

export interface CompleteResult {
  ownerType: "TASK" | "SUBTASK";
  ownerId: string;
  title: string;
  status: "DONE";
  /** 已完成过，本次没有产生新的副作用 */
  alreadyCompleted: boolean;
  /** 本次取消的未来有效 Schedule 数量 */
  cancelledScheduleCount: number;
  /** 本次是否因最后一个子任务完成而自动把父任务置为 DONE */
  parentAutoCompleted: boolean;
  parentTaskId: string | null;
}

const DONE = "DONE";

/**
 * 取消 owner 未来的有效 Schedule：startAt 严格晚于当前时间的非 CANCELLED 记录。
 * 已经开始或已经结束的 Schedule 视为历史，保持原状态。
 */
async function cancelFutureSchedules(
  tx: Prisma.TransactionClient,
  owner: { taskId?: string | null; subTaskId?: string | null },
  now: Date,
): Promise<string[]> {
  const where = owner.subTaskId
    ? { subTaskId: owner.subTaskId }
    : { taskId: owner.taskId as string };

  const targets = await tx.schedule.findMany({
    where: {
      ...where,
      status: { not: "CANCELLED" },
      startAt: { gt: now },
    },
    select: { id: true },
  });
  if (targets.length === 0) return [];

  const ids = targets.map((row) => row.id);
  await tx.schedule.updateMany({
    where: { id: { in: ids } },
    data: { status: "CANCELLED" },
  });
  return ids;
}

async function writeCompleteLog(
  tx: Prisma.TransactionClient,
  params: {
    taskId: string;
    ownerType: "TASK" | "SUBTASK";
    title: string;
    cancelledScheduleIds: string[];
    parentAutoCompleted: boolean;
    parentTaskId: string | null;
  },
): Promise<void> {
  const ownerLabel = params.ownerType === "TASK" ? "任务" : "执行步骤";
  const cancelledCount = params.cancelledScheduleIds.length;
  const autoNote =
    params.parentAutoCompleted && params.parentTaskId
      ? "所有执行步骤均已完成，主任务同步完成。"
      : "";

  await tx.decisionLog.create({
    data: {
      actionType: "COMPLETE",
      relatedTaskId: params.taskId,
      inputSummary: `用户将${ownerLabel}「${params.title}」标记为 DONE。`,
      outputSummary: `${ownerLabel}已完成；取消未来计划 ${cancelledCount} 个。${
        autoNote ? ` ${autoNote}` : ""
      }`,
      evidence: JSON.stringify({
        ownerType: params.ownerType,
        title: params.title,
        status: DONE,
        cancelledScheduleIds: params.cancelledScheduleIds,
        cancelledScheduleCount: cancelledCount,
        parentAutoCompleted: params.parentAutoCompleted,
        parentTaskId: params.parentTaskId,
      }),
    },
  });
}

/**
 * 完成一个没有 SubTask 的 Task。
 * 存在 SubTask 时拒绝直接完成，避免隐藏未完成工作。
 */
export async function completeTask(
  taskId: string,
  now: Date = new Date(),
): Promise<CompleteResult> {
  return prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({
      where: { id: taskId },
      include: { subTasks: { select: { id: true, status: true } } },
    });
    if (!task) {
      throw new CompleteError("TASK_NOT_FOUND", `任务不存在：${taskId}`);
    }

    if (task.status === DONE) {
      return {
        ownerType: "TASK",
        ownerId: task.id,
        title: task.title,
        status: DONE,
        alreadyCompleted: true,
        cancelledScheduleCount: 0,
        parentAutoCompleted: false,
        parentTaskId: null,
      };
    }

    if (task.subTasks.length > 0) {
      throw new CompleteError(
        "TASK_HAS_INCOMPLETE_SUBTASKS",
        `任务「${task.title}」仍有未完成的执行步骤，请逐个完成子任务。`,
      );
    }

    await tx.task.update({
      where: { id: task.id },
      data: { status: DONE },
    });

    const cancelledIds = await cancelFutureSchedules(tx, { taskId: task.id }, now);

    await writeCompleteLog(tx, {
      taskId: task.id,
      ownerType: "TASK",
      title: task.title,
      cancelledScheduleIds: cancelledIds,
      parentAutoCompleted: false,
      parentTaskId: null,
    });

    return {
      ownerType: "TASK",
      ownerId: task.id,
      title: task.title,
      status: DONE,
      alreadyCompleted: false,
      cancelledScheduleCount: cancelledIds.length,
      parentAutoCompleted: false,
      parentTaskId: null,
    };
  });
}

/**
 * 完成一个 SubTask。
 * 若同父 Task 的全部 SubTask 均已 DONE，则在同一事务内把父 Task 置为 DONE，
 * 并把这一派生结果记录在同一条 COMPLETE DecisionLog 中。
 */
export async function completeSubTask(
  subTaskId: string,
  now: Date = new Date(),
): Promise<CompleteResult> {
  return prisma.$transaction(async (tx) => {
    const subTask = await tx.subTask.findUnique({
      where: { id: subTaskId },
      include: { task: { select: { id: true, title: true, status: true } } },
    });
    if (!subTask) {
      throw new CompleteError("SUBTASK_NOT_FOUND", `子任务不存在：${subTaskId}`);
    }

    if (subTask.status === DONE) {
      return {
        ownerType: "SUBTASK",
        ownerId: subTask.id,
        title: subTask.title,
        status: DONE,
        alreadyCompleted: true,
        cancelledScheduleCount: 0,
        parentAutoCompleted: false,
        parentTaskId: subTask.taskId,
      };
    }

    await tx.subTask.update({
      where: { id: subTask.id },
      data: { status: DONE },
    });

    const cancelledIds = await cancelFutureSchedules(tx, { subTaskId: subTask.id }, now);

    // 检查同父 Task 是否已经全部完成（本次更新后重新查询）
    const remaining = await tx.subTask.count({
      where: { taskId: subTask.taskId, status: { not: DONE } },
    });

    let parentAutoCompleted = false;
    if (remaining === 0 && subTask.task.status !== DONE) {
      await tx.task.update({
        where: { id: subTask.taskId },
        data: { status: DONE },
      });
      parentAutoCompleted = true;
    }

    await writeCompleteLog(tx, {
      taskId: subTask.taskId,
      ownerType: "SUBTASK",
      title: subTask.title,
      cancelledScheduleIds: cancelledIds,
      parentAutoCompleted,
      parentTaskId: subTask.taskId,
    });

    return {
      ownerType: "SUBTASK",
      ownerId: subTask.id,
      title: subTask.title,
      status: DONE,
      alreadyCompleted: false,
      cancelledScheduleCount: cancelledIds.length,
      parentAutoCompleted,
      parentTaskId: subTask.taskId,
    };
  });
}
