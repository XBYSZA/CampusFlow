import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { MockAIProvider } from "../src/lib/ai/mock-provider";
import {
  DECOMPOSITION_MAX_SUBTASKS,
  DECOMPOSITION_MIN_SUBTASKS,
  decompositionResultSchema,
  validateDecomposition,
  type DecompositionResult,
  type ProposedSubTask,
} from "../src/lib/ai/contract";
import {
  TaskError,
  confirmDecomposition,
  decomposeTask,
  writeDecomposition,
} from "../src/lib/services/tasks";

// ============================================================
// S3 验证脚本：拆解契约 / 依赖 DAG / 事务写入与回滚 / 数据清理
// ============================================================

let failed = false;
function check(name: string, condition: boolean, detail = "") {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failed = true;
  console.log(`  [${status}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function sub(
  clientId: string,
  title: string,
  dependsOn: string[] = [],
  sortOrder = 0,
): ProposedSubTask {
  return {
    clientId,
    title,
    estimatedMinutes: 30,
    sortOrder,
    dependsOn,
  };
}

function resultOf(subtasks: ProposedSubTask[]): DecompositionResult {
  return { taskSummary: "校验用", subtasks };
}

async function main() {
  console.log("Verifying S3 task decomposition pipeline...");

  // ---------- 1~6：Mock Provider 输出质量 ----------
  const provider = new MockAIProvider();
  const input = {
    taskId: "verify-task-s3",
    title: "提交项目方案",
    description: "按比赛要求完成项目方案并提交",
    deadline: "2026-11-05T12:00:00.000Z",
    estimatedMinutes: 180,
    sourceContext: "校园比赛通知（验证用）",
  };

  const preview = await provider.decomposeTask(input);
  check("1. MockAIProvider.decomposeTask 正常工作", preview.subtasks.length > 0, `子任务 ${preview.subtasks.length} 个`);

  const second = await provider.decomposeTask(input);
  check("2. 同一输入重复调用结果确定一致", JSON.stringify(preview) === JSON.stringify(second));

  const parsed = decompositionResultSchema.safeParse(preview);
  check("3. 输出通过 Zod 契约校验", parsed.success, parsed.success ? "" : parsed.error.message);

  check(
    "4. 子任务数量合法",
    preview.subtasks.length >= DECOMPOSITION_MIN_SUBTASKS &&
      preview.subtasks.length <= DECOMPOSITION_MAX_SUBTASKS,
    `${preview.subtasks.length} 个（限制 ${DECOMPOSITION_MIN_SUBTASKS}~${DECOMPOSITION_MAX_SUBTASKS}）`,
  );

  const ids = preview.subtasks.map((s) => s.clientId);
  check("5. clientId 全部唯一", new Set(ids).size === ids.length, ids.join(", "));

  const depsResolvable = preview.subtasks.every((s) =>
    s.dependsOn.every((d) => ids.includes(d)),
  );
  check("6. dependsOn 只引用存在的节点", depsResolvable);

  // ---------- 7~10：DAG 校验（纯函数） ----------
  const selfProblems = validateDecomposition(resultOf([sub("a", "自依赖", ["a"]), sub("b", "正常", [], 1)]));
  check("7. 自依赖被拒绝", selfProblems.some((p) => p.includes("不能依赖自己")), selfProblems.join("；"));

  const twoCycle = validateDecomposition(
    resultOf([sub("a", "步骤A", ["b"]), sub("b", "步骤B", ["a"], 1)]),
  );
  check("8. 两节点循环依赖被拒绝", twoCycle.some((p) => p.includes("环")), twoCycle.join("；"));

  const multiCycle = validateDecomposition(
    resultOf([sub("a", "步骤A", ["c"]), sub("b", "步骤B", ["a"], 1), sub("c", "步骤C", ["b"], 2)]),
  );
  check("9. 多节点循环依赖被拒绝", multiCycle.some((p) => p.includes("环")), multiCycle.join("；"));

  const validDag = validateDecomposition(
    resultOf([sub("a", "步骤A"), sub("b", "步骤B", ["a"], 1), sub("c", "步骤C", ["a"], 2)]),
  );
  check("10. 合法 DAG 通过校验", validDag.length === 0, validDag.join("；"));

  // ---------- 准备临时数据 ----------
  const marker = `__s3_verify__ ${Date.now()}`;
  const baseline = {
    tasks: await prisma.task.count(),
    subTasks: await prisma.subTask.count(),
    dependencies: await prisma.subTaskDependency.count(),
    decisionLogs: await prisma.decisionLog.count(),
  };

  const tempTask = await prisma.task.create({
    data: {
      title: marker,
      description: "S3 验证临时任务（项目方案）",
      deadline: new Date("2026-11-05T12:00:00+08:00"),
      priority: "HIGH",
      estimatedMinutes: 180,
      status: "TODO",
    },
  });
  const rollbackTask = await prisma.task.create({
    data: { title: `${marker} 回滚用`, estimatedMinutes: 120, priority: "MEDIUM", status: "TODO" },
  });

  try {
    // 服务层 decomposeTask：查询真实任务 → 预览不写库
    const servicePreview = await decomposeTask(tempTask.id);
    check(
      "11a. 服务层 decomposeTask 返回预览且不写库",
      servicePreview.subtasks.length > 0 &&
        (await prisma.subTask.count({ where: { taskId: tempTask.id } })) === 0,
      `${servicePreview.subtasks.length} 个预览子任务`,
    );

    // 服务层拒绝已拆解任务重复拆解（先确认，再试一次）
    const confirmPayload = { subtasks: servicePreview.subtasks };
    const confirmed = await confirmDecomposition(tempTask.id, confirmPayload);

    // 11. SubTask 写入
    const createdSubTasks = await prisma.subTask.findMany({
      where: { taskId: tempTask.id },
      orderBy: { sortOrder: "asc" },
      include: { dependencies: true },
    });
    check(
      "11b. confirm 写入 SubTask",
      createdSubTasks.length === servicePreview.subtasks.length,
      `写入 ${createdSubTasks.length}/${servicePreview.subtasks.length}`,
    );

    // 12. 依赖正确建立（真实数据库 ID，而非 clientId 字符串）
    const expectedEdges = servicePreview.subtasks.reduce((sum, s) => sum + s.dependsOn.length, 0);
    const allDbIds = new Set(createdSubTasks.map((s) => s.id));
    const edgesUseDbIds = createdSubTasks.every((s) =>
      s.dependencies.every((d) => allDbIds.has(d.subTaskId) && allDbIds.has(d.dependsOnId)),
    );
    const actualEdges = createdSubTasks.reduce((sum, s) => sum + s.dependencies.length, 0);
    check(
      "12. SubTaskDependency 正确建立（映射为数据库 ID）",
      actualEdges === expectedEdges && edgesUseDbIds,
      `依赖 ${actualEdges}/${expectedEdges}`,
    );

    // 13. DecisionLog
    const logs = await prisma.decisionLog.findMany({ where: { relatedTaskId: tempTask.id } });
    const log = logs.find((l) => l.actionType === "DECOMPOSE");
    let logOk = false;
    if (log) {
      try {
        const evidence = JSON.parse(log.evidence ?? "{}") as {
          dependencies?: Array<{ subTaskId: string; dependsOnId: string }>;
        };
        logOk =
          log.id === confirmed.decisionLogId &&
          (evidence.dependencies?.length ?? -1) === expectedEdges &&
          evidence.dependencies!.every((d) => allDbIds.has(d.subTaskId) && allDbIds.has(d.dependsOnId));
      } catch {
        logOk = false;
      }
    }
    check("13. DecisionLog（DECOMPOSE）被创建且含依赖摘要", logOk);

    // 14. 重复确认被拒绝
    let duplicateRejected = false;
    let duplicateCode = "";
    try {
      await confirmDecomposition(tempTask.id, confirmPayload);
    } catch (e) {
      duplicateRejected = e instanceof TaskError && e.code === "ALREADY_DECOMPOSED";
      duplicateCode = e instanceof TaskError ? e.code : (e as Error).message;
    }
    let decomposeRejected = false;
    try {
      await decomposeTask(tempTask.id);
    } catch (e) {
      decomposeRejected = e instanceof TaskError && e.code === "ALREADY_DECOMPOSED";
    }
    check(
      "14. 同一已拆解任务再次 confirm / decompose 均被拒绝",
      duplicateRejected && decomposeRejected,
      duplicateCode,
    );

    // 15. transaction 失败整体回滚（故意在写入后抛错）
    let forcedFailed = false;
    try {
      await prisma.$transaction(async (tx) => {
        await writeDecomposition(
          tx,
          {
            id: rollbackTask.id,
            title: rollbackTask.title,
            deadline: rollbackTask.deadline,
            estimatedMinutes: rollbackTask.estimatedMinutes,
          },
          { taskSummary: "回滚验证", subtasks: servicePreview.subtasks },
        );
        throw new Error("__forced_transaction_failure__");
      });
    } catch {
      forcedFailed = true;
    }
    const leftoverSubTasks = await prisma.subTask.count({ where: { taskId: rollbackTask.id } });
    const leftoverLogs = await prisma.decisionLog.count({ where: { relatedTaskId: rollbackTask.id } });
    check(
      "15. transaction 失败不留半套数据",
      forcedFailed && leftoverSubTasks === 0 && leftoverLogs === 0,
      `残留 subtask=${leftoverSubTasks}, log=${leftoverLogs}`,
    );
  } finally {
    // ---------- 16. 清理，保证不污染 seed 与 S2 数据 ----------
    const tempTaskIds = [tempTask.id, rollbackTask.id];
    await prisma.decisionLog.deleteMany({ where: { relatedTaskId: { in: tempTaskIds } } });
    await prisma.subTask.deleteMany({ where: { taskId: { in: tempTaskIds } } }); // 级联删除依赖
    await prisma.task.deleteMany({ where: { id: { in: tempTaskIds } } });

    const after = {
      tasks: await prisma.task.count(),
      subTasks: await prisma.subTask.count(),
      dependencies: await prisma.subTaskDependency.count(),
      decisionLogs: await prisma.decisionLog.count(),
    };
    check(
      "16. 测试数据已清理，seed 与 S2 数据未被污染",
      JSON.stringify(baseline) === JSON.stringify(after),
      `before ${JSON.stringify(baseline)} → after ${JSON.stringify(after)}`,
    );
  }

  console.log("\nDecomposition preview:");
  for (const s of preview.subtasks) {
    console.log(
      `  ${s.sortOrder + 1}. ${s.title} | ${s.estimatedMinutes}min | 依赖 ${
        s.dependsOn.length > 0 ? s.dependsOn.join(", ") : "无"
      }`,
    );
  }

  if (failed) {
    console.error("\nS3 verification FAILED (see [FAIL] items above).");
    process.exitCode = 1;
  } else {
    console.log("\nS3 verification PASSED.");
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
