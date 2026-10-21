import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated/prisma/client";
import { DEMO_NOTICE } from "../src/lib/fixtures/demo-notice";
import { MockAIProvider } from "../src/lib/ai/mock-provider";
import {
  ESTIMATED_MINUTES_MAX,
  ESTIMATED_MINUTES_MIN,
  extractionResultSchema,
  validateEvidenceAgainstRawText,
} from "../src/lib/ai/contract";
import { confirmInbox, extractInbox, InboxError } from "../src/lib/services/inbox";

// ============================================================
// S2 验证脚本：Mock Provider / 契约校验 / 确定性 / confirm 入库与清理
// ============================================================

const adapter = new PrismaBetterSqlite3({
  url: process.env.DATABASE_URL ?? "file:./prisma/dev.db",
});
const prisma = new PrismaClient({ adapter });

let failed = false;
function check(name: string, condition: boolean, detail = "") {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failed = true;
  console.log(`  [${status}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log("Verifying S2 inbox extraction pipeline...");

  // ---------- 1~7：Mock Provider 输出质量 ----------
  const provider = new MockAIProvider();
  const result = await provider.extractTasks({
    rawText: DEMO_NOTICE.rawText,
    sourceTitle: DEMO_NOTICE.title,
  });

  const parsed = extractionResultSchema.safeParse(result);
  check("1. MockAIProvider 能解析演示通知", result.tasks.length > 0, `事件：${result.eventTitle}`);
  check("2. 输出通过 Zod 契约校验", parsed.success, parsed.success ? "" : parsed.error.message);
  check("3. 至少提取出 3 个任务", result.tasks.length >= 3, `共 ${result.tasks.length} 个`);

  const allEvidenceValid = result.tasks.every((t) =>
    t.evidence.every((ev) => validateEvidenceAgainstRawText(DEMO_NOTICE.rawText, ev) === null),
  );
  const allSliceEqual = result.tasks.every((t) =>
    t.evidence.every((ev) => DEMO_NOTICE.rawText.slice(ev.start, ev.end) === ev.quote),
  );
  check("4. 所有 evidence quote 都真实存在于原文", allEvidenceValid);
  check("5. 所有 evidence 满足 slice(start, end) === quote", allSliceEqual);

  const deadlinesValid = result.tasks.every(
    (t) => t.deadline === null || (!Number.isNaN(Date.parse(t.deadline)) && t.deadline.startsWith("202")),
  );
  check("6. deadline 均为 null 或合法 ISO 时间", deadlinesValid);

  const minutesValid = result.tasks.every(
    (t) =>
      Number.isInteger(t.estimatedMinutes) &&
      t.estimatedMinutes >= ESTIMATED_MINUTES_MIN &&
      t.estimatedMinutes <= ESTIMATED_MINUTES_MAX,
  );
  check(
    "7. estimatedMinutes 在允许范围",
    minutesValid,
    result.tasks.map((t) => `${t.title}:${t.estimatedMinutes}min`).join(", "),
  );

  // ---------- 8：确定性 ----------
  const secondRun = await provider.extractTasks({
    rawText: DEMO_NOTICE.rawText,
    sourceTitle: DEMO_NOTICE.title,
  });
  check(
    "8. 同一样本多次运行结果完全一致（确定性）",
    JSON.stringify(result) === JSON.stringify(secondRun),
  );

  // ---------- 服务层：空输入与 evidence 篡改拦截（补充健壮性） ----------
  let emptyRejected = false;
  try {
    await extractInbox({ rawText: "   " });
  } catch (e) {
    emptyRejected = e instanceof InboxError && e.code === "EMPTY_INPUT";
  }
  check("9a. 服务层拒绝空输入（EMPTY_INPUT）", emptyRejected);

  const tamperedPayload = {
    sourceTitle: "__s2_verify__ 篡改测试",
    rawText: DEMO_NOTICE.rawText,
    eventTitle: result.eventTitle,
    tasks: [
      {
        ...result.tasks[0],
        deadline: result.tasks[0].deadline,
        description: result.tasks[0].description ?? null,
        evidence: [{ quote: "原文中不存在的一句话", start: 0, end: 9 }],
      },
    ],
  };
  let tamperRejected = false;
  try {
    await confirmInbox(tamperedPayload);
  } catch (e) {
    tamperRejected = e instanceof InboxError && e.code === "EVIDENCE_INVALID";
  }
  check("9b. confirm 拒绝被篡改的 evidence（EVIDENCE_INVALID）", tamperRejected);

  // ---------- 10：confirm 入库 + 清理 ----------
  const marker = `__s2_verify__ ${Date.now()}`;
  const sourceCountBefore = await prisma.source.count();

  const confirmPayload = {
    sourceTitle: marker,
    rawText: DEMO_NOTICE.rawText + `\n\n（验证标记：${marker}）`, // 避免与演示数据/重复检测冲突
    eventTitle: result.eventTitle,
    submissionId: "s2-verify-submission",
    tasks: result.tasks.map((t) => ({
      title: t.title,
      description: t.description ?? null,
      deadline: t.deadline,
      priority: t.priority,
      estimatedMinutes: t.estimatedMinutes,
      evidence: t.evidence,
    })),
  };

  let confirmOk = false;
  let createdSourceId = "";
  let createdTaskIds: string[] = [];
  let createdLogIds: string[] = [];
  try {
    const confirmed = await confirmInbox(confirmPayload);
    createdSourceId = confirmed.sourceId;
    createdTaskIds = confirmed.taskIds;
    createdLogIds = confirmed.decisionLogIds;

    const dbSource = await prisma.source.findUnique({
      where: { id: createdSourceId },
      include: { tasks: true },
    });
    const dbLogs = await prisma.decisionLog.findMany({
      where: { id: { in: createdLogIds } },
    });
    confirmOk =
      dbSource?.tasks.length === result.tasks.length &&
      dbLogs.length === result.tasks.length &&
      dbLogs.every((l) => l.actionType === "EXTRACT" && l.relatedTaskId !== null);
  } catch (e) {
    console.log("    confirm 异常：", (e as Error).message);
  }
  check(
    "10a. confirm 服务写入 Source / Task / DecisionLog",
    confirmOk,
    `tasks=${createdTaskIds.length}, logs=${createdLogIds.length}`,
  );

  // 清理验证数据，确认不污染演示 seed
  let cleaned = false;
  try {
    if (createdLogIds.length > 0) {
      await prisma.decisionLog.deleteMany({ where: { id: { in: createdLogIds } } });
    }
    if (createdSourceId) {
      await prisma.source.delete({ where: { id: createdSourceId } }); // 级联删除 Task
    }
    const sourceCountAfter = await prisma.source.count();
    const tasksLeft = createdTaskIds.length
      ? await prisma.task.count({ where: { id: { in: createdTaskIds } } })
      : 0;
    const logsLeft = createdLogIds.length
      ? await prisma.decisionLog.count({ where: { id: { in: createdLogIds } } })
      : 0;
    cleaned = sourceCountAfter === sourceCountBefore && tasksLeft === 0 && logsLeft === 0;
  } catch (e) {
    console.log("    清理异常：", (e as Error).message);
  }
  check("10b. 验证数据已清理，演示 seed 未被污染", cleaned);

  // 汇总
  console.log("\nExtraction preview:");
  for (const t of result.tasks) {
    console.log(
      `  - ${t.title} | ${t.priority} | ${t.estimatedMinutes}min | 截止 ${t.deadline ?? "无"}`,
    );
    console.log(`    依据：「${t.evidence[0]?.quote.slice(0, 40)}…」 [${t.evidence[0]?.start}, ${t.evidence[0]?.end})`);
  }

  if (failed) {
    console.error("\nS2 verification FAILED (see [FAIL] items above).");
    process.exitCode = 1;
  } else {
    console.log("\nS2 verification PASSED.");
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
