import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated/prisma/client";
import {
  findDependencyCycle,
  isValidCourseMinutes,
  isValidDayOfWeek,
} from "../src/lib/domain";

// S1 数据层验证脚本：通过 Prisma Client 查询种子数据的完整关联链
const adapter = new PrismaBetterSqlite3({
  url: process.env.DATABASE_URL ?? "file:./prisma/dev.db",
});
const prisma = new PrismaClient({ adapter });

const DEMO_SOURCE_ID = "src_campus_innovation_contest_2026";
const DEMO_SCHEDULE_ID = "sched_write_proposal_1022";
const DEMO_DECISION_LOG_ID = "dlog_extract_contest_001";

let failed = false;
function check(name: string, condition: boolean, detail = "") {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failed = true;
  console.log(`  [${status}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log("Verifying S1 data layer...");

  // 1. Source → Task → SubTask → dependencies
  const source = await prisma.source.findUnique({
    where: { id: DEMO_SOURCE_ID },
    include: {
      tasks: {
        include: {
          subTasks: {
            orderBy: { sortOrder: "asc" },
            include: { dependencies: { include: { dependsOn: true } } },
          },
        },
      },
    },
  });
  check("Source 存在且类型为 NOTICE", source?.sourceType === "NOTICE");

  const task = source?.tasks[0];
  check("Source 关联 1 个 Task", source?.tasks.length === 1);
  check(
    "Task 截止日期为 2026-10-25 18:00",
    task?.deadline?.toISOString() === "2026-10-25T10:00:00.000Z",
    task?.deadline?.toISOString() ?? "null",
  );
  check("Task 关联 3 个 SubTask", task?.subTasks.length === 3);

  const [proposal, slides, rehearsal] = task?.subTasks ?? [];
  check(
    "子任务排序：写方案(1) → 做PPT(2) → 排练(3)",
    proposal?.sortOrder === 1 && slides?.sortOrder === 2 && rehearsal?.sortOrder === 3,
  );
  check(
    "依赖链：PPT→方案、排练→PPT",
    slides?.dependencies[0]?.dependsOnId === proposal?.id &&
      rehearsal?.dependencies[0]?.dependsOnId === slides?.id,
  );
  const cycle = findDependencyCycle([
    { subTaskId: slides!.id, dependsOnId: proposal!.id },
    { subTaskId: rehearsal!.id, dependsOnId: slides!.id },
  ]);
  check("依赖关系无环（findDependencyCycle）", cycle === null);

  // 2. Course 取值范围校验
  const courses = await prisma.course.findMany({
    orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }],
  });
  check("Course 共 2 门", courses.length === 2);
  check(
    "Course dayOfWeek / 分钟段合法",
    courses.every(
      (c) => isValidDayOfWeek(c.dayOfWeek) && isValidCourseMinutes(c.startMinute, c.endMinute),
    ),
    courses.map((c) => `${c.title}(周${c.dayOfWeek} ${c.startMinute}-${c.endMinute})`).join(", "),
  );

  // 3. Schedule → SubTask 关联与互斥约束
  const schedule = await prisma.schedule.findUnique({
    where: { id: DEMO_SCHEDULE_ID },
    include: { subTask: true, task: true },
  });
  check("Schedule 存在且关联 SubTask（撰写项目方案）", schedule?.subTask?.title === "撰写项目方案初稿");
  check(
    "Schedule 关联互斥：subTask 有值时 task 为空",
    schedule?.subTaskId != null && schedule.taskId === null,
  );
  check(
    "Schedule 时间段合法（endAt > startAt）",
    schedule != null && schedule.endAt.getTime() > schedule.startAt.getTime(),
  );
  check(
    "Schedule 排期早于 Task 截止时间",
    task != null && schedule != null && schedule.endAt.getTime() < task.deadline!.getTime(),
  );

  // 4. DecisionLog → Task 关联，evidence 可追溯回 Source 原文
  const decisionLog = await prisma.decisionLog.findUnique({
    where: { id: DEMO_DECISION_LOG_ID },
    include: { relatedTask: true },
  });
  check("DecisionLog 关联主任务", decisionLog?.relatedTaskId === task?.id);
  let evidenceTraceable = false;
  try {
    const evidence = JSON.parse(decisionLog?.evidence ?? "[]") as Array<{ quote: string }>;
    evidenceTraceable =
      Array.isArray(evidence) &&
      evidence.length > 0 &&
      evidence.every((e) => source?.rawText.includes(e.quote));
  } catch {
    evidenceTraceable = false;
  }
  check("DecisionLog.evidence 引文可在 Source.rawText 中找到", evidenceTraceable);

  // 5. Conflict 表可通过模型表达（当前无数据，验证连接可查询即可）
  const conflicts = await prisma.conflict.findMany();
  check("Conflict 表可查询（当前无种子数据）", conflicts.length === 0);

  // 汇总
  console.log("\nRelation chain:");
  console.log(`  Source "${source?.title}"`);
  console.log(`    └─ Task "${task?.title}" (deadline ${task?.deadline?.toLocaleString("zh-CN")})`);
  for (const st of task?.subTasks ?? []) {
    const depNames = st.dependencies.map((d) => `← ${d.dependsOn.title}`).join(" ");
    console.log(`        └─ SubTask #${st.sortOrder} ${st.title} ${depNames}`);
  }
  for (const c of courses) {
    console.log(`  Course: ${c.title} 周${["日", "一", "二", "三", "四", "五", "六"][c.dayOfWeek]} ${c.startMinute}-${c.endMinute}`);
  }
  console.log(`  Schedule: ${schedule?.startAt.toLocaleString("zh-CN")} → ${schedule?.subTask?.title}`);
  console.log(`  DecisionLog: [${decisionLog?.actionType}] ${decisionLog?.outputSummary}`);

  if (failed) {
    console.error("\nS1 verification FAILED (see [FAIL] items above).");
    process.exitCode = 1;
  } else {
    console.log("\nS1 verification PASSED: all relations resolved correctly.");
  }
}

main()
  .catch((error) => {
    console.error("Verification crashed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
