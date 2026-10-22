import "dotenv/config";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated/prisma/client";

// ============================================================
// Demo 重置逻辑验证（S9）：npm run demo:verify
//
// 在独立临时库 dev.db.demo-verify 上完整执行两轮
// 「删除 → migrate deploy → seed → demo fixture」，
// 验证 demo 重置的可重复性与最终演示基线正确性。
// 不触碰开发数据库 prisma/dev.db，结束后自动清理临时库。
// ============================================================

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_RELATIVE_PATH = "prisma/dev.db.demo-verify";
const DATABASE_URL = `file:./${DB_RELATIVE_PATH}`;
const DB_ABSOLUTE_PATH = path.join(PROJECT_ROOT, DB_RELATIVE_PATH);
const DB_FILE_SUFFIXES = ["", "-journal", "-wal", "-shm"];

let failed = false;
function check(name: string, condition: boolean, detail = "") {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failed = true;
  console.log(`  [${status}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function removeDatabaseFiles(): void {
  for (const suffix of DB_FILE_SUFFIXES) {
    rmSync(`${DB_ABSOLUTE_PATH}${suffix}`, { force: true });
  }
}

function runStep(command: string): void {
  execSync(command, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL },
  });
}

function hashEnvFile(): string | null {
  const envPath = path.join(PROJECT_ROOT, ".env");
  if (!existsSync(envPath)) return null;
  return createHash("sha256").update(readFileSync(envPath)).digest("hex");
}

interface DemoSnapshot {
  counts: Record<string, number>;
  courses: Array<{ title: string; dayOfWeek: number; startMinute: number; endMinute: number }>;
  tasks: Array<{ title: string; status: string; estimatedMinutes: number | null; deadline: string | null }>;
  tables: string[];
}

async function snapshot(): Promise<DemoSnapshot> {
  const adapter = new PrismaBetterSqlite3({ url: DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  try {
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

    const courseRows = await prisma.course.findMany({
      orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }],
      select: { title: true, dayOfWeek: true, startMinute: true, endMinute: true },
    });
    const taskRows = await prisma.task.findMany({
      orderBy: { id: "asc" },
      select: { title: true, status: true, estimatedMinutes: true, deadline: true },
    });
    const tableRows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );

    return {
      counts: { courses, tasks, subTasks, sources, schedules, calendarEvents, conflicts, decisionLogs },
      courses: courseRows,
      tasks: taskRows.map((t) => ({
        title: t.title,
        status: t.status,
        estimatedMinutes: t.estimatedMinutes,
        deadline: t.deadline ? t.deadline.toISOString() : null,
      })),
      tables: tableRows.map((row) => row.name),
    };
  } finally {
    await prisma.$disconnect();
  }
}

function runDemoCycle(label: string): void {
  console.log(`\n[demo:verify] ${label}`);
  removeDatabaseFiles();
  runStep("npx prisma migrate deploy");
  runStep("npx prisma db seed");
  runStep("npx tsx scripts/demo-fixture.ts");
}

async function main(): Promise<number> {
  const envHashBefore = hashEnvFile();
  try {
    runDemoCycle("第一轮完整重置");
    const first = await snapshot();
    check("1. 第一次 demo 重置成功并产生演示基线", first.counts.courses > 0 && first.counts.tasks > 0);

    runDemoCycle("第二轮完整重置");
    const second = await snapshot();
    check("2. 第二次 demo 重置仍成功", second.counts.courses > 0 && second.counts.tasks > 0);

    check(
      "3. 两次重置最终数据数量完全一致",
      JSON.stringify(first.counts) === JSON.stringify(second.counts),
      JSON.stringify(second.counts),
    );
    check(
      "4. 两次重置 Course 数据一致",
      JSON.stringify(first.courses) === JSON.stringify(second.courses),
      second.courses.map((c) => `${c.title}(周${c.dayOfWeek})`).join(", "),
    );
    check(
      "5. 两次重置 Task 数据一致",
      JSON.stringify(first.tasks) === JSON.stringify(second.tasks),
      second.tasks.map((t) => t.title).join(", "),
    );

    check("6. Course 共 3 门（高等数学 / 数据结构 / 大学英语）",
      second.counts.courses === 3 &&
        ["高等数学", "数据结构", "大学英语"].every((t) => second.courses.some((c) => c.title === t)),
    );
    check("7. Task 共 2 个且均为 TODO 普通任务",
      second.counts.tasks === 2 && second.tasks.every((t) => t.status === "TODO"),
    );
    check("8. Schedule = 0（演示现场生成计划）", second.counts.schedules === 0);
    check("9. CalendarEvent = 0（冲突现场演示）", second.counts.calendarEvents === 0);
    check("10. Conflict = 0", second.counts.conflicts === 0);
    check(
      "11. DecisionLog = 0（不伪造 EXTRACT/DECOMPOSE/PLAN/REPLAN/COMPLETE 历史）",
      second.counts.decisionLogs === 0,
    );
    check("12. Source = 0（Inbox 保持现场提取状态）", second.counts.sources === 0);

    const expectedTables = [
      "Source", "Task", "SubTask", "SubTaskDependency",
      "Course", "Schedule", "CalendarEvent", "Conflict", "DecisionLog",
      "_prisma_migrations",
    ];
    check(
      "13. 数据库结构正常（migration 与全部业务表存在）",
      expectedTables.every((table) => second.tables.includes(table)),
      second.tables.join(","),
    );

    const envHashAfter = hashEnvFile();
    check("14. .env 未被修改", envHashBefore === envHashAfter);
  } catch (error) {
    console.error("[demo:verify] 执行失败：", (error as Error).message);
    failed = true;
  } finally {
    removeDatabaseFiles();
    console.log("\n[demo:verify] 已清理临时数据库：prisma/dev.db.demo-verify");
  }

  if (failed) {
    console.error("[demo:verify] FAILED");
    return 1;
  }
  console.log("[demo:verify] 全部通过（14 项）");
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("[demo:verify] crashed:", error);
    process.exitCode = 1;
  });
