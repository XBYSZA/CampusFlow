import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/lib/prisma";
import { buildDecisionTimeline, DecisionError } from "../src/lib/services/decision";
import { completeSubTask, completeTask, CompleteError } from "../src/lib/services/completion";
import { buildPlanningItems, loadPlanningContext } from "../src/lib/services/schedule";
import { generateReplanPreview } from "../src/lib/services/replan";
import { decisionTimelineSchema } from "../src/lib/decision/contract";
import { shanghaiDate } from "../src/lib/time";

// ============================================================
// S7 验证脚本：DecisionLog → DecisionTimeline 聚合与角色映射
//
// 在隔离临时库上运行（见 run-verify-s7.ts），不触碰 dev.db。
// 所有自建数据带 verify_s7_ 前缀，结束后精确清理，不全表 delete。
// ============================================================

let failed = false;
let total = 0;
function check(name: string, condition: boolean, detail = "") {
  total += 1;
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failed = true;
  console.log(`  [${status}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const PREFIX = "verify_s7_";

const SOURCE_A = `${PREFIX}source_a`;
const TASK_A = `${PREFIX}task_a`;
const SUB_S1 = `${PREFIX}sub_s1`;
const SUB_S2 = `${PREFIX}sub_s2`;
const SUB_S3 = `${PREFIX}sub_s3`;
const LOG_EXTRACT = `${PREFIX}log_extract`;
const LOG_DECOMPOSE = `${PREFIX}log_decompose`;
const LOG_PLAN = `${PREFIX}log_plan`;
const LOG_REPLAN = `${PREFIX}log_replan`;
const SCHED_PLAN = `${PREFIX}sched_plan`;
const SCHED_OLD = `${PREFIX}sched_old`;
const SCHED_NEW = `${PREFIX}sched_new`;
const EVENT_A = `${PREFIX}event_a`;
const CONFLICT_A = `${PREFIX}conflict_a`;
const TASK_B = `${PREFIX}task_b`;
const SOURCE_C = `${PREFIX}source_c`;
const TASK_C = `${PREFIX}task_c`;
const LOG_C_EXTRACT = `${PREFIX}log_c_extract`;

const RAW_TEXT_A = "请在10月26日22:00前提交作品方案，预计准备3小时。";
const QUOTE_A = "请在10月26日22:00前提交作品方案";

async function cleanup() {
  await prisma.conflict.deleteMany({
    where: {
      OR: [
        { scheduleAId: { startsWith: PREFIX } },
        { scheduleBId: { startsWith: PREFIX } },
        { calendarEventId: { startsWith: PREFIX } },
      ],
    },
  });
  await prisma.calendarEvent.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.schedule.deleteMany({
    where: { OR: [{ taskId: { startsWith: PREFIX } }, { subTaskId: { startsWith: PREFIX } }] },
  });
  await prisma.decisionLog.deleteMany({ where: { relatedTaskId: { startsWith: PREFIX } } });
  await prisma.subTaskDependency.deleteMany({ where: { subTaskId: { startsWith: PREFIX } } });
  await prisma.subTask.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.task.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.source.deleteMany({ where: { id: { startsWith: PREFIX } } });
}

async function seed() {
  // ---------- Task A：全链路（Source + EXTRACT + DECOMPOSE + PLAN + REPLAN） ----------
  await prisma.source.create({
    data: {
      id: SOURCE_A,
      title: `${PREFIX}创新赛通知`,
      rawText: RAW_TEXT_A,
      sourceType: "NOTICE",
      capturedAt: shanghaiDate(2026, 10, 22, 9, 0),
    },
  });

  await prisma.task.create({
    data: {
      id: TASK_A,
      sourceId: SOURCE_A,
      title: `${PREFIX}提交作品方案`,
      deadline: shanghaiDate(2026, 10, 26, 22, 0),
      priority: "HIGH",
      estimatedMinutes: 180,
      status: "TODO",
      subTasks: {
        create: [
          { id: SUB_S1, title: "梳理要求", estimatedMinutes: 30, sortOrder: 1 },
          {
            id: SUB_S2,
            title: "完成初稿",
            estimatedMinutes: 90,
            sortOrder: 2,
            dependencies: { create: [{ dependsOnId: SUB_S1 }] },
          },
          {
            id: SUB_S3,
            title: "检查提交",
            estimatedMinutes: 60,
            sortOrder: 3,
            dependencies: { create: [{ dependsOnId: SUB_S2 }] },
          },
        ],
      },
    },
  });

  await prisma.decisionLog.create({
    data: {
      id: LOG_EXTRACT,
      actionType: "EXTRACT",
      relatedTaskId: TASK_A,
      inputSummary: "rawText 长度 28；AI provider=mock；model=mock-v1；promptVersion=2；耗时 12ms",
      outputSummary: "从原始通知中识别出 1 个任务",
      evidence: JSON.stringify([
        { quote: QUOTE_A, field: "deadline", start: 0, end: QUOTE_A.length },
      ]),
      createdAt: shanghaiDate(2026, 10, 22, 10, 0),
    },
  });

  await prisma.decisionLog.create({
    data: {
      id: LOG_DECOMPOSE,
      actionType: "DECOMPOSE",
      relatedTaskId: TASK_A,
      inputSummary: "任务「提交作品方案」；AI provider=mock；model=mock-v1；promptVersion=1；耗时 8ms",
      outputSummary: "拆解为 3 个子任务",
      evidence: JSON.stringify({
        subtasks: [
          { clientId: "c1", title: "梳理要求", estimatedMinutes: 30, sortOrder: 1, dependsOn: [] },
          { clientId: "c2", title: "完成初稿", estimatedMinutes: 90, sortOrder: 2, dependsOn: ["c1"] },
          { clientId: "c3", title: "检查提交", estimatedMinutes: 60, sortOrder: 3, dependsOn: ["c2"] },
        ],
        dependencies: [
          { subTaskId: SUB_S2, dependsOnId: SUB_S1 },
          { subTaskId: SUB_S3, dependsOnId: SUB_S2 },
        ],
      }),
      createdAt: shanghaiDate(2026, 10, 22, 11, 0),
    },
  });

  const planStart = shanghaiDate(2026, 10, 23, 20, 30);
  const planEnd = shanghaiDate(2026, 10, 23, 22, 0);
  await prisma.schedule.create({
    data: {
      id: SCHED_PLAN,
      subTaskId: SUB_S2,
      startAt: planStart,
      endAt: planEnd,
      status: "CONFIRMED",
      rationale: "19:00-20:30 有课程占用，最近合法时段为 20:30-22:00",
    },
  });
  await prisma.decisionLog.create({
    data: {
      id: LOG_PLAN,
      actionType: "PLAN",
      relatedTaskId: TASK_A,
      inputSummary: "待排对象 3；已有日程 0；课程 2",
      outputSummary: "生成 1 个计划块",
      evidence: JSON.stringify({
        strategy: "按截止时间优先，30 分钟网格贪心",
        rangeStart: shanghaiDate(2026, 10, 20, 0, 0).toISOString(),
        rangeEnd: shanghaiDate(2026, 10, 27, 0, 0).toISOString(),
        blocks: [
          {
            ownerType: "SUBTASK",
            ownerId: SUB_S2,
            title: "完成初稿",
            startAt: planStart.toISOString(),
            endAt: planEnd.toISOString(),
            rationale: "19:00-20:30 有课程占用，最近合法时段为 20:30-22:00",
          },
        ],
        unscheduled: [],
      }),
      createdAt: shanghaiDate(2026, 10, 22, 12, 0),
    },
  });

  // REPLAN：旧计划 08:00-09:00 被讲座冲突 → 新计划 09:30-10:30
  const oldStart = shanghaiDate(2026, 10, 23, 8, 0);
  const oldEnd = shanghaiDate(2026, 10, 23, 9, 0);
  const newStart = shanghaiDate(2026, 10, 23, 9, 30);
  const newEnd = shanghaiDate(2026, 10, 23, 10, 30);
  await prisma.calendarEvent.create({
    data: {
      id: EVENT_A,
      title: `${PREFIX}学院创新讲座`,
      startAt: oldStart,
      endAt: oldEnd,
      eventType: "LECTURE",
    },
  });
  await prisma.schedule.create({
    data: {
      id: SCHED_OLD,
      subTaskId: SUB_S3,
      startAt: oldStart,
      endAt: oldEnd,
      status: "CANCELLED",
      rationale: "原计划：截止前最近的早晨时段",
    },
  });
  await prisma.schedule.create({
    data: {
      id: SCHED_NEW,
      subTaskId: SUB_S3,
      startAt: newStart,
      endAt: newEnd,
      status: "CONFIRMED",
      rationale: "避开 08:00-09:00 的固定讲座",
    },
  });
  await prisma.conflict.create({
    data: {
      id: CONFLICT_A,
      scheduleAId: SCHED_OLD,
      calendarEventId: EVENT_A,
      conflictType: "OVERLAP",
      description: `${PREFIX}与「学院创新讲座」重叠 60 分钟`,
      resolution: "REPLANNED",
      resolvedAt: shanghaiDate(2026, 10, 22, 13, 0),
    },
  });
  await prisma.decisionLog.create({
    data: {
      id: LOG_REPLAN,
      actionType: "REPLAN",
      relatedTaskId: TASK_A,
      inputSummary: "未解决冲突 1；受影响对象 1",
      outputSummary: "重排 1 个对象：1 条旧计划已取消，1 条新计划已确认",
      evidence: JSON.stringify({
        strategy: "仅重排受冲突影响的任务，保持其他日程不变",
        conflictIds: [CONFLICT_A],
        cancelledScheduleIds: [SCHED_OLD],
        newScheduleIds: [SCHED_NEW],
        blocks: [
          {
            ownerType: "SUBTASK",
            ownerId: SUB_S3,
            title: "检查提交",
            startAt: newStart.toISOString(),
            endAt: newEnd.toISOString(),
            rationale: "避开 08:00-09:00 的固定讲座",
          },
        ],
      }),
      createdAt: shanghaiDate(2026, 10, 22, 13, 0),
    },
  });

  // ---------- Task B：手动创建，无来源、无决策日志 ----------
  await prisma.task.create({
    data: {
      id: TASK_B,
      title: `${PREFIX}手动任务`,
      priority: "MEDIUM",
      status: "TODO",
    },
  });

  // ---------- Task C：有来源，只有 EXTRACT 阶段（阶段缺失容错） ----------
  await prisma.source.create({
    data: {
      id: SOURCE_C,
      title: `${PREFIX}班会通知`,
      rawText: "周五下午开班会。",
      sourceType: "NOTICE",
    },
  });
  await prisma.task.create({
    data: {
      id: TASK_C,
      sourceId: SOURCE_C,
      title: `${PREFIX}参加班会`,
      priority: "LOW",
      status: "TODO",
    },
  });
  await prisma.decisionLog.create({
    data: {
      id: LOG_C_EXTRACT,
      actionType: "EXTRACT",
      relatedTaskId: TASK_C,
      inputSummary: "rawText 长度 8；AI provider=mock；model=mock-v1；promptVersion=2；耗时 5ms",
      outputSummary: "识别出 1 个任务",
      evidence: JSON.stringify([{ quote: "周五下午开班会", start: 0, end: 7 }]),
      createdAt: shanghaiDate(2026, 10, 22, 14, 0),
    },
  });
}

async function main() {
  console.log("[s7:verify] 决策解释时间线聚合验证开始");
  await cleanup();
  await seed();

  // ================= Task A：全链路时间线 =================
  const timelineA = await buildDecisionTimeline(TASK_A);

  check(
    "01 Task 有 Source 时能聚合来源标题与类型",
    timelineA.source?.title === `${PREFIX}创新赛通知` && timelineA.source.sourceType === "NOTICE",
    timelineA.source?.title,
  );

  const extractStage = timelineA.stages.find((s) => s.type === "EXTRACT");
  check(
    "02 evidence quote 与原文一致且带上下文",
    extractStage?.evidence[0]?.quote === QUOTE_A &&
      (extractStage.evidence[0].context ?? "").includes(QUOTE_A),
    extractStage?.evidence[0]?.quote,
  );

  check(
    "03 EXTRACT 映射为 AI 阶段并解析 AI 调用上下文",
    extractStage?.actor === "AI" &&
      extractStage.aiContext?.provider === "mock" &&
      extractStage.aiContext.model === "mock-v1" &&
      extractStage.aiContext.promptVersion === "2" &&
      extractStage.aiContext.durationMs === 12,
    `actor=${extractStage?.actor} provider=${extractStage?.aiContext?.provider}`,
  );

  const decomposeStage = timelineA.stages.find((s) => s.type === "DECOMPOSE");
  check(
    "04 DECOMPOSE 映射为 AI 阶段且展示 ①②③ 依赖",
    decomposeStage?.actor === "AI" &&
      decomposeStage.details.length === 3 &&
      decomposeStage.details[0].label.startsWith("①") &&
      decomposeStage.details[1].value.includes("依赖：① 梳理要求") &&
      decomposeStage.details[2].value.includes("依赖：② 完成初稿"),
    decomposeStage?.details.map((d) => d.label).join(" / "),
  );

  const planStage = timelineA.stages.find((s) => s.type === "PLAN");
  check(
    "05 PLAN 映射为 RULE_ENGINE 且包含策略与 rationale",
    planStage?.actor === "RULE_ENGINE" &&
      planStage.details.some((d) => d.label === "排期策略") &&
      planStage.details.some((d) => d.value.includes("依据：19:00-20:30 有课程占用")),
    `actor=${planStage?.actor}`,
  );

  const replanStage = timelineA.stages.find((s) => s.type === "REPLAN");
  check("06 REPLAN 映射为 RULE_ENGINE", replanStage?.actor === "RULE_ENGINE", `actor=${replanStage?.actor}`);

  const oldDetail = replanStage?.details.find((d) => d.label.startsWith("原计划·"));
  const newDetail = replanStage?.details.find((d) => d.label.startsWith("新计划·"));
  check(
    "07 Schedule 历史区分 CANCELLED / CONFIRMED",
    (oldDetail?.value ?? "").includes("已取消，保留历史") &&
      (newDetail?.value ?? "").includes("已确认"),
    `${oldDetail?.value ?? "?"} | ${newDetail?.value ?? "?"}`,
  );

  check(
    "08 冲突 old → new 正确映射并展示固定占用方",
    !!replanStage &&
      replanStage.details.some((d) => d.label === "触发冲突" && d.value.includes("学院创新讲座")) &&
      replanStage.details.some((d) => d.label === "固定占用方" && d.value.includes("学院创新讲座")) &&
      (oldDetail?.value ?? "").includes("10月23日 08:00") &&
      (newDetail?.value ?? "").includes("10月23日 09:30"),
    `${oldDetail?.value ?? "?"} → ${newDetail?.value ?? "?"}`,
  );

  // ================= Task B：无来源、无日志 =================
  const timelineB = await buildDecisionTimeline(TASK_B);
  check("09 无 Source 的 Task 不崩溃且 source 为 null", timelineB.source === null);
  check("10 无 DecisionLog 的 Task 返回空 timeline", timelineB.stages.length === 0);

  // ================= Task C：阶段缺失容错 =================
  const timelineC = await buildDecisionTimeline(TASK_C);
  check(
    "11 只有 EXTRACT 的 Task 不崩溃且仅含该阶段",
    timelineC.stages.length === 1 && timelineC.stages[0].type === "EXTRACT",
    `stages=${timelineC.stages.map((s) => s.type).join(",")}`,
  );

  // ================= aiContext 边界：只是调用上下文，不是审计证据 =================
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const drawerSource = readFileSync(
    path.join(projectRoot, "src/components/decision-drawer.tsx"),
    "utf8",
  );
  const contractSource = readFileSync(
    path.join(projectRoot, "src/lib/decision/contract.ts"),
    "utf8",
  );
  const aiContextKeys = Object.keys(extractStage?.aiContext ?? {}).sort();
  check(
    "12 provider meta 仅为「AI 调用上下文」，未被标记为审计证据",
    drawerSource.includes("AI 调用上下文") &&
      !drawerSource.includes("不可篡改") &&
      contractSource.includes("非审计证据") &&
      aiContextKeys.join(",") === "durationMs,model,promptVersion,provider",
    aiContextKeys.join(","),
  );

  // ================= 契约校验（API 出口结构） =================
  const parseA = decisionTimelineSchema.safeParse(timelineA);
  const parseB = decisionTimelineSchema.safeParse(timelineB);
  const parseC = decisionTimelineSchema.safeParse(timelineC);
  check(
    "13 聚合结果全部通过 DecisionTimeline Zod 契约",
    parseA.success && parseB.success && parseC.success,
  );

  // ================= 阶段顺序与容错 =================
  const typesA = timelineA.stages.map((s) => s.type);
  check(
    "14 阶段按时间顺序排列 EXTRACT → DECOMPOSE → PLAN → REPLAN",
    typesA.join(",") === "EXTRACT,DECOMPOSE,PLAN,REPLAN",
    typesA.join(","),
  );

  let notFoundCode = "";
  try {
    await buildDecisionTimeline(`${PREFIX}not_exist`);
  } catch (error) {
    notFoundCode = error instanceof DecisionError ? error.code : "UNEXPECTED";
  }
  check("15 不存在的 Task 返回 TASK_NOT_FOUND（API 404 基础）", notFoundCode === "TASK_NOT_FOUND", notFoundCode);

  // 人工确认说明：不伪造时间与身份
  check(
    "16 各阶段带有人工确认说明且不含伪造时间",
    timelineA.stages.every(
      (s) => s.confirmedNote === "该结果经用户确认后写入正式数据。" && !/\d{4}/.test(s.confirmedNote),
    ),
  );

  // ================= S7.2 任务完成闭环 =================
  const NOW_DONE = shanghaiDate(2026, 10, 22, 9, 0);
  const TASK_D = `${PREFIX}task_d`;
  const TASK_E = `${PREFIX}task_e`;
  const SUB_E1 = `${PREFIX}sub_e1`;
  const SUB_E2 = `${PREFIX}sub_e2`;
  const TASK_F = `${PREFIX}task_f`;
  const TASK_R = `${PREFIX}task_r`;
  const SUB_R = `${PREFIX}sub_r`;
  const SCHED_D_FUTURE = `${PREFIX}sched_d_future`;
  const SCHED_D_PAST = `${PREFIX}sched_d_past`;
  const SCHED_F = `${PREFIX}sched_f`;
  const SCHED_E1_FUTURE = `${PREFIX}sched_e1_future`;
  const SCHED_E1_PAST = `${PREFIX}sched_e1_past`;
  const SCHED_R = `${PREFIX}sched_r`;
  const EVENT_R = `${PREFIX}event_r`;
  const CONFLICT_R = `${PREFIX}conflict_r`;

  await prisma.task.create({
    data: {
      id: TASK_D,
      title: `${PREFIX}简单任务`,
      priority: "MEDIUM",
      status: "TODO",
      estimatedMinutes: 30,
      deadline: shanghaiDate(2026, 10, 28, 18, 0),
    },
  });
  await prisma.schedule.create({
    data: {
      id: SCHED_D_FUTURE,
      taskId: TASK_D,
      startAt: shanghaiDate(2026, 10, 27, 9, 0),
      endAt: shanghaiDate(2026, 10, 27, 10, 0),
      status: "CONFIRMED",
      rationale: "未来计划，完成时应取消",
    },
  });
  await prisma.schedule.create({
    data: {
      id: SCHED_D_PAST,
      taskId: TASK_D,
      startAt: shanghaiDate(2026, 10, 21, 9, 0),
      endAt: shanghaiDate(2026, 10, 21, 10, 0),
      status: "CONFIRMED",
      rationale: "历史计划，完成后应保留",
    },
  });

  await prisma.task.create({
    data: {
      id: TASK_F,
      title: `${PREFIX}无关任务`,
      priority: "LOW",
      status: "TODO",
      estimatedMinutes: 30,
      deadline: shanghaiDate(2026, 10, 28, 18, 0),
    },
  });
  await prisma.schedule.create({
    data: {
      id: SCHED_F,
      taskId: TASK_F,
      startAt: shanghaiDate(2026, 10, 27, 11, 0),
      endAt: shanghaiDate(2026, 10, 27, 12, 0),
      status: "CONFIRMED",
      rationale: "无关计划，不应受其他任务完成影响",
    },
  });

  await prisma.task.create({
    data: {
      id: TASK_E,
      title: `${PREFIX}多步骤任务`,
      priority: "HIGH",
      status: "TODO",
      estimatedMinutes: 120,
      deadline: shanghaiDate(2026, 10, 28, 18, 0),
      subTasks: {
        create: [
          { id: SUB_E1, title: "步骤一", estimatedMinutes: 60, status: "TODO", sortOrder: 1 },
          { id: SUB_E2, title: "步骤二", estimatedMinutes: 60, status: "TODO", sortOrder: 2 },
        ],
      },
    },
  });
  await prisma.schedule.create({
    data: {
      id: SCHED_E1_FUTURE,
      subTaskId: SUB_E1,
      startAt: shanghaiDate(2026, 10, 27, 15, 0),
      endAt: shanghaiDate(2026, 10, 27, 16, 0),
      status: "CONFIRMED",
      rationale: "未来计划，完成子任务时应取消",
    },
  });
  await prisma.schedule.create({
    data: {
      id: SCHED_E1_PAST,
      subTaskId: SUB_E1,
      startAt: shanghaiDate(2026, 10, 21, 15, 0),
      endAt: shanghaiDate(2026, 10, 21, 16, 0),
      status: "CONFIRMED",
      rationale: "历史计划，完成后应保留",
    },
  });

  const completedTaskD = await completeTask(TASK_D, NOW_DONE);
  check(
    "18. 无 SubTask 的 Task 可以完成",
    completedTaskD.status === "DONE" &&
      completedTaskD.alreadyCompleted === false &&
      completedTaskD.cancelledScheduleCount === 1,
    `status=${completedTaskD.status} cancelled=${completedTaskD.cancelledScheduleCount}`,
  );
  const taskDAfter = await prisma.task.findUnique({ where: { id: TASK_D } });
  check("19. Task.status 已变为 DONE", taskDAfter?.status === "DONE", taskDAfter?.status);

  let parentRejectCode = "";
  try {
    await completeTask(TASK_E, NOW_DONE);
  } catch (error) {
    parentRejectCode = error instanceof CompleteError ? error.code : "UNEXPECTED";
  }
  const taskEAfterReject = await prisma.task.findUnique({ where: { id: TASK_E } });
  const taskELogsAfterReject = await prisma.decisionLog.count({
    where: { relatedTaskId: TASK_E, actionType: "COMPLETE" },
  });
  check(
    "20. 有未完成 SubTask 的父 Task 直接完成被拒绝",
    parentRejectCode === "TASK_HAS_INCOMPLETE_SUBTASKS",
    parentRejectCode,
  );
  check(
    "21. 拒绝后无半状态：父 Task 仍 TODO 且未写入 COMPLETE 日志",
    taskEAfterReject?.status === "TODO" && taskELogsAfterReject === 0,
    `status=${taskEAfterReject?.status} logs=${taskELogsAfterReject}`,
  );

  const completedSubE1 = await completeSubTask(SUB_E1, NOW_DONE);
  const subE1After = await prisma.subTask.findUnique({ where: { id: SUB_E1 } });
  const taskEAfterFirst = await prisma.task.findUnique({ where: { id: TASK_E } });
  check(
    "22. SubTask 可以完成",
    completedSubE1.status === "DONE" && subE1After?.status === "DONE",
    subE1After?.status,
  );
  check(
    "23. 仅部分 SubTask DONE 时父 Task 仍未完成",
    taskEAfterFirst?.status === "TODO" && completedSubE1.parentAutoCompleted === false,
    `parent=${taskEAfterFirst?.status}`,
  );

  const schedDFuture = await prisma.schedule.findUnique({ where: { id: SCHED_D_FUTURE } });
  const schedDPast = await prisma.schedule.findUnique({ where: { id: SCHED_D_PAST } });
  const schedE1Future = await prisma.schedule.findUnique({ where: { id: SCHED_E1_FUTURE } });
  const schedE1Past = await prisma.schedule.findUnique({ where: { id: SCHED_E1_PAST } });
  const schedF = await prisma.schedule.findUnique({ where: { id: SCHED_F } });
  check(
    "24. 完成时未来有效 Schedule → CANCELLED",
    schedDFuture?.status === "CANCELLED" && schedE1Future?.status === "CANCELLED",
    `task=${schedDFuture?.status} sub=${schedE1Future?.status}`,
  );
  check(
    "25. 过去 Schedule 保留原状态且未被删除",
    !!schedDPast && schedDPast.status === "CONFIRMED" &&
      !!schedE1Past && schedE1Past.status === "CONFIRMED",
    `task=${schedDPast?.status} sub=${schedE1Past?.status}`,
  );
  check(
    "26. 无关 Schedule 不受影响",
    schedF?.status === "CONFIRMED",
    schedF?.status,
  );

  const completedSubE2 = await completeSubTask(SUB_E2, NOW_DONE);
  const taskEAfterAll = await prisma.task.findUnique({ where: { id: TASK_E } });
  check(
    "27. 最后一个 SubTask DONE 后父 Task 自动 DONE",
    completedSubE2.parentAutoCompleted === true && taskEAfterAll?.status === "DONE",
    `auto=${completedSubE2.parentAutoCompleted} parent=${taskEAfterAll?.status}`,
  );

  // ---------- 已完成 owner 不参与 planning / replan ----------
  const planningContext = await loadPlanningContext();
  const planningBuild = buildPlanningItems(planningContext.tasks, planningContext.scheduledOwnerIds);
  const plannedOwnerIds = planningBuild.items.map((item) => item.ownerId);
  check(
    "28. 已完成 owner 不进入 PlanningItem",
    !plannedOwnerIds.includes(TASK_D) &&
      !plannedOwnerIds.includes(SUB_E1) &&
      !plannedOwnerIds.includes(SUB_E2),
    `items=${plannedOwnerIds.filter((id) => id.startsWith(PREFIX)).join(",")}`,
  );

  await prisma.task.create({
    data: {
      id: TASK_R,
      title: `${PREFIX}已完成子任务重排验证`,
      priority: "MEDIUM",
      status: "TODO",
      estimatedMinutes: 60,
      deadline: shanghaiDate(2026, 10, 28, 18, 0),
      subTasks: {
        create: [{ id: SUB_R, title: "已完成的步骤", estimatedMinutes: 60, status: "DONE", sortOrder: 1 }],
      },
    },
  });
  await prisma.schedule.create({
    data: {
      id: SCHED_R,
      subTaskId: SUB_R,
      startAt: shanghaiDate(2026, 10, 27, 10, 0),
      endAt: shanghaiDate(2026, 10, 27, 11, 0),
      status: "CONFIRMED",
      rationale: "已完成对象的既有计划，不应被重排",
    },
  });
  await prisma.calendarEvent.create({
    data: {
      id: EVENT_R,
      title: `${PREFIX}重排固定事件`,
      startAt: shanghaiDate(2026, 10, 27, 10, 30),
      endAt: shanghaiDate(2026, 10, 27, 11, 30),
      eventType: "MEETING",
    },
  });
  await prisma.conflict.create({
    data: {
      id: CONFLICT_R,
      scheduleAId: SCHED_R,
      calendarEventId: EVENT_R,
      conflictType: "OVERLAP",
      description: `${PREFIX}已完成对象与固定事件重叠`,
    },
  });

  const replanForDone = await generateReplanPreview([CONFLICT_R], NOW_DONE);
  check(
    "29. 已完成 owner 不进入 Replan 重排新计划",
    replanForDone.newBlocks.every((block) => block.ownerId !== SUB_R) &&
      replanForDone.unresolved.some(
        (item) => item.ownerId === SUB_R && item.reason.includes("已完成"),
      ),
    `newBlocks=${replanForDone.newBlocks.length}`,
  );

  // ---------- COMPLETE 日志与时间线 ----------
  const completeLogsD = await prisma.decisionLog.findMany({
    where: { relatedTaskId: TASK_D, actionType: "COMPLETE" },
  });
  const logEvidenceD = completeLogsD[0]
    ? (JSON.parse(completeLogsD[0].evidence ?? "{}") as Record<string, unknown>)
    : {};
  check(
    "30. COMPLETE DecisionLog 被创建且记录对象/状态/取消数量",
    completeLogsD.length === 1 &&
      logEvidenceD.ownerType === "TASK" &&
      logEvidenceD.status === "DONE" &&
      logEvidenceD.cancelledScheduleCount === 1,
    `logs=${completeLogsD.length}`,
  );

  const timelineD = await buildDecisionTimeline(TASK_D);
  const completeStageD = timelineD.stages.find((s) => s.type === "COMPLETE");
  check(
    "31. COMPLETE 在 DecisionTimeline 中映射为 HUMAN",
    completeStageD?.actor === "HUMAN" &&
      completeStageD.title === "任务完成" &&
      completeStageD.details.some((d) => d.label === "完成对象") &&
      completeStageD.details.some((d) => d.label === "状态" && d.value.includes("DONE")) &&
      completeStageD.details.some((d) => d.label === "未来计划" && d.value.includes("1")),
    `actor=${completeStageD?.actor}`,
  );

  const timelineE = await buildDecisionTimeline(TASK_E);
  const completeStagesE = timelineE.stages.filter((s) => s.type === "COMPLETE");
  const autoStageE = completeStagesE.find((s) =>
    s.details.some((d) => d.label === "主任务联动"),
  );
  check(
    "32. 子任务完成展示为执行步骤完成，自动完成父任务有派生说明",
    completeStagesE.length === 2 &&
      completeStagesE.every((s) => s.actor === "HUMAN" && s.title === "执行步骤完成") &&
      !!autoStageE,
    `stages=${completeStagesE.length}`,
  );
  check(
    "33. 含 COMPLETE 的时间线仍通过 Zod 契约",
    decisionTimelineSchema.safeParse(timelineD).success &&
      decisionTimelineSchema.safeParse(timelineE).success,
  );

  const logsBeforeRepeat = await prisma.decisionLog.count({
    where: { relatedTaskId: TASK_D, actionType: "COMPLETE" },
  });
  const repeatTaskD = await completeTask(TASK_D, NOW_DONE);
  const repeatSubE2 = await completeSubTask(SUB_E2, NOW_DONE);
  const logsAfterRepeat = await prisma.decisionLog.count({
    where: { relatedTaskId: TASK_D, actionType: "COMPLETE" },
  });
  check(
    "34. 重复完成幂等，不产生重复副作用",
    repeatTaskD.alreadyCompleted === true &&
      repeatTaskD.cancelledScheduleCount === 0 &&
      repeatSubE2.alreadyCompleted === true &&
      logsAfterRepeat === logsBeforeRepeat,
    `logs=${logsAfterRepeat}`,
  );

  // ================= 清理与不污染验证 =================
  await cleanup();
  const leftovers = await prisma.task.count({ where: { id: { startsWith: PREFIX } } });
  const leftoverLogs = await prisma.decisionLog.count({
    where: { relatedTaskId: { startsWith: PREFIX } } ,
  });
  const leftoverSources = await prisma.source.count({ where: { id: { startsWith: PREFIX } } });
  const leftoverSchedules = await prisma.schedule.count({
    where: { OR: [{ taskId: { startsWith: PREFIX } }, { subTaskId: { startsWith: PREFIX } }] },
  });
  const leftoverConflicts = await prisma.conflict.count({
    where: { scheduleAId: { startsWith: PREFIX } },
  });
  const leftoverEvents = await prisma.calendarEvent.count({ where: { id: { startsWith: PREFIX } } });
  check(
    "35. 测试数据精确清理，不污染数据库（隔离库运行，dev.db 零接触）",
    leftovers + leftoverLogs + leftoverSources + leftoverSchedules + leftoverConflicts + leftoverEvents === 0,
    `task=${leftovers} log=${leftoverLogs} source=${leftoverSources} schedule=${leftoverSchedules} conflict=${leftoverConflicts} event=${leftoverEvents}`,
  );

  if (failed) {
    console.log("[s7:verify] 存在失败项");
    process.exitCode = 1;
  } else {
    console.log("[s7:verify] 全部通过（" + total + " 项）");
  }
}

main()
  .catch(async (error) => {
    console.error("[s7:verify] 执行异常：", error);
    await cleanup();
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
