import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated/prisma/client";

// ============================================================
// Demo Fixture（S9）：在 migrate deploy + seed 之后执行，
// 把数据库精简为适合现场演示的稳定初始状态。
//
// 原则：
// - 删除 seed 中 AI 主流程的预置数据（Source / 大赛任务链 / Schedule / DecisionLog），
//   让 Inbox 保持「现场粘贴通知 → AI 提取 → 人工确认」的可演示状态；
// - 不伪造任何 EXTRACT / DECOMPOSE / PLAN / REPLAN / COMPLETE 决策历史，
//   正式决策历史应由现场操作真实产生；
// - 保留并补齐固定课程（不可移动硬约束）；
// - 预置 2 个与 AI 主流程无关的普通任务，让日程页不至于完全空白；
// - 全部使用固定 ID upsert / 精确删除，重复执行结果一致。
// ============================================================

const adapter = new PrismaBetterSqlite3({
  url: process.env.DATABASE_URL ?? "file:./prisma/dev.db",
});
const prisma = new PrismaClient({ adapter });

// seed.ts 中 AI 主流程预置数据的固定 ID（精确删除，不做全表清空）
const SEED_AI_FLOW_IDS = {
  decisionLogs: ["dlog_extract_contest_001"],
  schedules: ["sched_write_proposal_1022"],
  dependencies: ["dep_slides_to_proposal", "dep_rehearsal_to_slides"],
  subTasks: ["subtask_write_proposal", "subtask_make_slides", "subtask_rehearsal_defense"],
  tasks: ["task_contest_materials_2026", "task_data_structure_report_2026"],
  sources: ["src_campus_innovation_contest_2026", "src_course_design_report_2026"],
} as const;

// 演示用固定课程：在 seed 的 2 门基础上补齐第 3 门（周五大学英语）
const DEMO_COURSE = {
  id: "course_english_fri",
  title: "大学英语",
  dayOfWeek: 5, // 周五
  startMinute: 600, // 10:00
  endMinute: 690, // 11:30
  location: "文科楼C-105",
} as const;

// 演示用普通任务：与 AI 主流程无关，TODO 状态，可供现场生成计划
const DEMO_TASKS = [
  {
    id: "task_demo_library_return",
    title: "图书馆归还资料",
    description: "归还借阅的参考书，避免逾期",
    deadline: new Date("2026-10-27T18:00:00+08:00"),
    priority: "LOW",
    estimatedMinutes: 30,
    status: "TODO",
  },
  {
    id: "task_demo_course_reading",
    title: "完成课程阅读",
    description: "阅读本周课程指定章节并做笔记",
    deadline: new Date("2026-10-28T20:00:00+08:00"),
    priority: "MEDIUM",
    estimatedMinutes: 60,
    status: "TODO",
  },
] as const;

async function main() {
  console.log("Applying demo fixture...");

  // 1. 精确删除 seed 中的 AI 主流程预置数据（按外键依赖顺序）
  await prisma.decisionLog.deleteMany({ where: { id: { in: [...SEED_AI_FLOW_IDS.decisionLogs] } } });
  await prisma.schedule.deleteMany({ where: { id: { in: [...SEED_AI_FLOW_IDS.schedules] } } });
  await prisma.subTaskDependency.deleteMany({
    where: { id: { in: [...SEED_AI_FLOW_IDS.dependencies] } },
  });
  await prisma.subTask.deleteMany({ where: { id: { in: [...SEED_AI_FLOW_IDS.subTasks] } } });
  await prisma.task.deleteMany({ where: { id: { in: [...SEED_AI_FLOW_IDS.tasks] } } });
  await prisma.source.deleteMany({ where: { id: { in: [...SEED_AI_FLOW_IDS.sources] } } });

  // 2. 固定课程：补齐周五大学英语（seed 已有高等数学周一 / 数据结构周三）
  await prisma.course.upsert({
    where: { id: DEMO_COURSE.id },
    update: { ...DEMO_COURSE },
    create: { ...DEMO_COURSE },
  });

  // 3. 普通演示任务（无来源、未拆解、TODO）
  for (const task of DEMO_TASKS) {
    await prisma.task.upsert({
      where: { id: task.id },
      update: { ...task },
      create: { ...task },
    });
  }

  // 4. 最终摘要（不打印任何环境变量或密钥）
  const [courses, tasks, subTasks, sources, schedules, calendarEvents, conflicts, decisionLogs] =
    await Promise.all([
      prisma.course.count(),
      prisma.task.count(),
      prisma.subTask.count(),
      prisma.source.count(),
      prisma.schedule.count(),
      prisma.calendarEvent.count(),
      prisma.conflict.count(),
      prisma.decisionLog.count(),
    ]);

  console.log("Demo database ready");
  console.log(`  Courses: ${courses}`);
  console.log(`  Tasks: ${tasks}（SubTask: ${subTasks}）`);
  console.log(`  Sources: ${sources}`);
  console.log(`  Schedules: ${schedules}`);
  console.log(`  CalendarEvents: ${calendarEvents}`);
  console.log(`  Conflicts: ${conflicts}`);
  console.log(`  DecisionLogs: ${decisionLogs}`);
}

main()
  .catch((error) => {
    console.error("Demo fixture failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
