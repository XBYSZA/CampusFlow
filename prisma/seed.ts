import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated/prisma/client";

// Prisma 7：SQLite 通过官方 driver adapter 连接
const adapter = new PrismaBetterSqlite3({
  url: process.env.DATABASE_URL ?? "file:./prisma/dev.db",
});
const prisma = new PrismaClient({ adapter });

// 固定演示数据 ID：重复运行 seed 时按 id upsert，保证幂等（不会产生重复记录）
const DEMO_IDS = {
  source: "src_campus_innovation_contest_2026",
  task: "task_contest_materials_2026",
  subTask1: "subtask_write_proposal",
  subTask2: "subtask_make_slides",
  subTask3: "subtask_rehearsal_defense",
  dependency1: "dep_slides_to_proposal",
  dependency2: "dep_rehearsal_to_slides",
  course1: "course_data_structure_wed",
  course2: "course_advanced_math_mon",
  schedule1: "sched_write_proposal_1022",
  decisionLog1: "dlog_extract_contest_001",
  // S3：一个尚未拆解的任务，用于演示 AI 拆解流程
  source2: "src_course_design_report_2026",
  task2: "task_data_structure_report_2026",
} as const;

// 完全虚构的校园创新大赛通知样本（真实感强，无真实人名/邮箱/电话）
const DEMO_RAW_TEXT = `【校学生会】关于举办2026年"校园创新大赛"的通知

各位同学：

为激发校园创新活力，校学生会定于2026年11月举办"校园创新大赛"。

一、参赛对象：全校在读本科生、研究生，可个人或组队报名（每队不超过4人）。
二、报名方式：填写报名表发送至学生会邮箱，报名及作品提交截止时间为2026年10月25日18:00。
三、赛程安排：11月8日初赛路演，11月22日决赛答辩。
四、奖项设置：一等奖1名、二等奖2名、三等奖3名，获奖团队颁发证书及奖金。

请有意参赛的同学按时提交材料。

校学生会
2026年10月20日`;

const DEADLINE_QUOTE = "报名及作品提交截止时间为2026年10月25日18:00";

// 完全虚构的课程设计报告要求（S3 演示：尚未拆解的任务）
const COURSE_REPORT_RAW_TEXT = `【课程通知】《数据结构》课程设计报告要求

各位同学：

本学期课程设计报告要求如下，请在截止时间前完成并提交。

一、报告内容：题目分析、数据结构与算法设计、核心代码说明、测试结果与总结。
二、格式要求：正文不超过 20 页，需附源代码清单与运行截图。
三、提交方式：纸质版交至任课教师办公室，电子版发送至课程邮箱。
四、提交截止时间为 2026 年 11 月 20 日 23:59，逾期不予受理。

请合理安排时间，避免临近截止集中赶工。

课程组
2026 年 10 月 21 日`;

async function main() {
  console.log("Seeding CampusFlow demo data (idempotent upsert)...");

  // 1. Source：原始通知
  await prisma.source.upsert({
    where: { id: DEMO_IDS.source },
    update: {
      title: "校园创新大赛报名通知（校学生会）",
      rawText: DEMO_RAW_TEXT,
      sourceType: "NOTICE",
    },
    create: {
      id: DEMO_IDS.source,
      title: "校园创新大赛报名通知（校学生会）",
      rawText: DEMO_RAW_TEXT,
      sourceType: "NOTICE",
      capturedAt: new Date("2026-10-20T09:30:00+08:00"),
    },
  });

  // 2. Task：从通知提取的主任务（截止日期可追溯到原文）
  await prisma.task.upsert({
    where: { id: DEMO_IDS.task },
    update: {
      sourceId: DEMO_IDS.source,
      title: "完成校园创新大赛报名材料",
      description: "按通知要求准备报名表、项目方案并按时提交",
      deadline: new Date("2026-10-25T18:00:00+08:00"),
      priority: "HIGH",
      estimatedMinutes: 240,
      status: "TODO",
    },
    create: {
      id: DEMO_IDS.task,
      sourceId: DEMO_IDS.source,
      title: "完成校园创新大赛报名材料",
      description: "按通知要求准备报名表、项目方案并按时提交",
      deadline: new Date("2026-10-25T18:00:00+08:00"),
      priority: "HIGH",
      estimatedMinutes: 240,
      status: "TODO",
    },
  });

  // 2b. S3 演示用：一个尚未拆解的任务（课程设计报告），供 /tasks 演示 AI 拆解
  await prisma.source.upsert({
    where: { id: DEMO_IDS.source2 },
    update: {
      title: "《数据结构》课程设计报告要求（演示样本）",
      rawText: COURSE_REPORT_RAW_TEXT,
      sourceType: "COURSE_NOTICE",
    },
    create: {
      id: DEMO_IDS.source2,
      title: "《数据结构》课程设计报告要求（演示样本）",
      rawText: COURSE_REPORT_RAW_TEXT,
      sourceType: "COURSE_NOTICE",
      capturedAt: new Date("2026-10-21T10:00:00+08:00"),
    },
  });

  await prisma.task.upsert({
    where: { id: DEMO_IDS.task2 },
    update: {
      sourceId: DEMO_IDS.source2,
      title: "完成《数据结构》课程设计报告",
      description:
        "按课程要求完成设计报告：含题目分析、数据结构与算法设计、测试结果与总结，并在截止前提交纸质版与电子版",
      deadline: new Date("2026-11-20T23:59:00+08:00"),
      priority: "MEDIUM",
      estimatedMinutes: 300,
      status: "TODO",
    },
    create: {
      id: DEMO_IDS.task2,
      sourceId: DEMO_IDS.source2,
      title: "完成《数据结构》课程设计报告",
      description:
        "按课程要求完成设计报告：含题目分析、数据结构与算法设计、测试结果与总结，并在截止前提交纸质版与电子版",
      deadline: new Date("2026-11-20T23:59:00+08:00"),
      priority: "MEDIUM",
      estimatedMinutes: 300,
      status: "TODO",
    },
  });

  // 3. SubTask：拆解结果（写方案 → 做PPT → 排练，线性依赖）
  const subTasks = [
    {
      id: DEMO_IDS.subTask1,
      title: "撰写项目方案初稿",
      estimatedMinutes: 90,
      sortOrder: 1,
    },
    {
      id: DEMO_IDS.subTask2,
      title: "制作路演 PPT",
      estimatedMinutes: 60,
      sortOrder: 2,
    },
    {
      id: DEMO_IDS.subTask3,
      title: "模拟答辩排练",
      estimatedMinutes: 45,
      sortOrder: 3,
    },
  ];
  for (const subTask of subTasks) {
    await prisma.subTask.upsert({
      where: { id: subTask.id },
      update: { ...subTask, taskId: DEMO_IDS.task, status: "TODO" },
      create: { ...subTask, taskId: DEMO_IDS.task, status: "TODO" },
    });
  }

  // 4. 依赖关系：做PPT 依赖 写方案；排练 依赖 做PPT
  const dependencies = [
    { id: DEMO_IDS.dependency1, subTaskId: DEMO_IDS.subTask2, dependsOnId: DEMO_IDS.subTask1 },
    { id: DEMO_IDS.dependency2, subTaskId: DEMO_IDS.subTask3, dependsOnId: DEMO_IDS.subTask2 },
  ];
  for (const dep of dependencies) {
    await prisma.subTaskDependency.upsert({
      where: { id: dep.id },
      update: { subTaskId: dep.subTaskId, dependsOnId: dep.dependsOnId },
      create: dep,
    });
  }

  // 5. 固定课程：每周课表占用（周三 14:00-15:40 / 周一 08:00-09:40）
  const courses = [
    {
      id: DEMO_IDS.course1,
      title: "数据结构",
      dayOfWeek: 3, // 周三
      startMinute: 840, // 14:00
      endMinute: 940, // 15:40
      location: "教学楼A-301",
    },
    {
      id: DEMO_IDS.course2,
      title: "高等数学",
      dayOfWeek: 1, // 周一
      startMinute: 480, // 08:00
      endMinute: 580, // 09:40
      location: "理科楼B-201",
    },
  ];
  for (const course of courses) {
    await prisma.course.upsert({
      where: { id: course.id },
      update: { ...course },
      create: course,
    });
  }

  // 6. Schedule：为"撰写项目方案"排期（周四晚，避开课程占用，早于截止）
  const scheduleRationale =
    "截止 2026-10-25 18:00（来源：通知原文）；周一/周三白天有固定课程占用，" +
    "故排在周四 19:00 空闲时段；前置子任务暂无，剩余时间充足。";
  await prisma.schedule.upsert({
    where: { id: DEMO_IDS.schedule1 },
    update: {
      subTaskId: DEMO_IDS.subTask1,
      taskId: null,
      startAt: new Date("2026-10-22T19:00:00+08:00"),
      endAt: new Date("2026-10-22T20:30:00+08:00"),
      status: "PROPOSED",
      rationale: scheduleRationale,
    },
    create: {
      id: DEMO_IDS.schedule1,
      subTaskId: DEMO_IDS.subTask1,
      startAt: new Date("2026-10-22T19:00:00+08:00"),
      endAt: new Date("2026-10-22T20:30:00+08:00"),
      status: "PROPOSED",
      rationale: scheduleRationale,
    },
  });

  // 7. DecisionLog：EXTRACT 决策记录（evidence 可追溯回 Source 原文）
  await prisma.decisionLog.upsert({
    where: { id: DEMO_IDS.decisionLog1 },
    update: {
      actionType: "EXTRACT",
      inputSummary: "收件箱粘贴通知文本 246 字（来源：校学生会通知）",
      outputSummary:
        "识别事件：校园创新大赛；任务 1 项：完成报名材料；截止 2026-10-25 18:00；优先级 HIGH",
      evidence: JSON.stringify(
        [{ field: "deadline", quote: DEADLINE_QUOTE }],
      ),
      relatedTaskId: DEMO_IDS.task,
    },
    create: {
      id: DEMO_IDS.decisionLog1,
      actionType: "EXTRACT",
      inputSummary: "收件箱粘贴通知文本 246 字（来源：校学生会通知）",
      outputSummary:
        "识别事件：校园创新大赛；任务 1 项：完成报名材料；截止 2026-10-25 18:00；优先级 HIGH",
      evidence: JSON.stringify([{ field: "deadline", quote: DEADLINE_QUOTE }]),
      relatedTaskId: DEMO_IDS.task,
    },
  });

  // 输出统计（全局计数仅作展示；幂等性由固定 ID upsert 保证）
  const [sources, tasks, subTaskCount, deps, coursesCount, schedules, decisionLogs] =
    await Promise.all([
      prisma.source.count(),
      prisma.task.count(),
      prisma.subTask.count(),
      prisma.subTaskDependency.count(),
      prisma.course.count(),
      prisma.schedule.count(),
      prisma.decisionLog.count(),
    ]);

  console.log("Seed complete:");
  console.log(`  Source: ${sources}, Task: ${tasks}, SubTask: ${subTaskCount},`);
  console.log(
    `  Dependency: ${deps}, Course: ${coursesCount}, Schedule: ${schedules}, DecisionLog: ${decisionLogs}`,
  );
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
