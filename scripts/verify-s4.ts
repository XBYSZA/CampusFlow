import "dotenv/config";
import { planSchedule, type BusyInterval } from "../src/lib/planning/engine";
import type { PlanBlock, PlanningItem } from "../src/lib/planning/contract";
import {
  buildPlanningItems,
  confirmPlan,
  ScheduleError,
  writePlan,
  type PlanningTaskInput,
} from "../src/lib/services/schedule";
import { prisma } from "../src/lib/prisma";
import {
  intervalsOverlap,
  minuteOfDay,
  PLAN_GRID_MINUTES,
  shanghaiDate,
  weekdayOf,
} from "../src/lib/time";

// ============================================================
// S4 验证脚本：排期契约 / 确定性引擎 / 确认事务 / 数据清理
// 固定 now 与范围，保证结果可复现。
// ============================================================

let failed = false;
function check(name: string, condition: boolean, detail = "") {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failed = true;
  console.log(`  [${status}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function expectCode(name: string, fn: () => Promise<unknown>, expected: string) {
  try {
    await fn();
    check(name, false, "没有抛出错误");
  } catch (error) {
    const ok = error instanceof ScheduleError && error.code === expected;
    check(name, ok, ok ? expected : `${(error as Error).message}`);
  }
}

const NOW = shanghaiDate(2026, 10, 21, 9, 0); // 周三 09:00
const RANGE_START = shanghaiDate(2026, 10, 19, 0, 0); // 周一
const RANGE_END = shanghaiDate(2026, 10, 26, 0, 0); // 下周一

const COURSES = [
  {
    id: "verify-s4-course-wed",
    title: "数据结构",
    dayOfWeek: 3,
    startMinute: 840,
    endMinute: 940,
    location: "教学楼A-301",
  },
  {
    id: "verify-s4-course-mon",
    title: "高等数学",
    dayOfWeek: 1,
    startMinute: 480,
    endMinute: 580,
    location: "理科楼B-201",
  },
];

function item(
  partial: Partial<PlanningItem> & { ownerId: string },
): PlanningItem {
  return {
    ownerType: "TASK",
    ownerId: partial.ownerId,
    taskId: partial.taskId ?? partial.ownerId,
    title: partial.title ?? `临时对象 ${partial.ownerId}`,
    estimatedMinutes: partial.estimatedMinutes ?? 60,
    deadline:
      partial.deadline === undefined
        ? "2026-10-25T18:00:00+08:00"
        : partial.deadline,
    dependsOnOwnerIds: partial.dependsOnOwnerIds ?? [],
    priority: partial.priority ?? "MEDIUM",
  };
}

function runPlan(extra: {
  items: PlanningItem[];
  busy?: BusyInterval[];
  dependencyReadyAt?: Array<{ ownerId: string; readyAt: Date }>;
}) {
  return planSchedule({
    items: extra.items,
    courses: COURSES,
    busy: extra.busy ?? [],
    dependencyReadyAt: extra.dependencyReadyAt,
    rangeStart: RANGE_START,
    rangeEnd: RANGE_END,
    now: NOW,
  });
}

function durationOf(block: PlanBlock): number {
  return (
    (new Date(block.endAt).getTime() - new Date(block.startAt).getTime()) / 60000
  );
}

const PREFIX = "verify_s4_";
const TASK_IDS = {
  a: "verify_s4_task_a",
  b: "verify_s4_task_b",
  c: "verify_s4_task_c",
  d: "verify_s4_task_d",
};
const COURSE_ID = "verify_s4_course_fri";

async function cleanup() {
  await prisma.decisionLog.deleteMany({
    where: { relatedTaskId: { in: Object.values(TASK_IDS) } },
  });
  await prisma.schedule.deleteMany({
    where: {
      OR: [
        { taskId: { startsWith: PREFIX } },
        { subTaskId: { startsWith: PREFIX } },
      ],
    },
  });
  await prisma.task.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.course.deleteMany({ where: { id: { startsWith: PREFIX } } });
}

async function main() {
  console.log("Verifying S4 planning engine...");

  // ------------------------------------------------------------
  // A. PlanningItem 构建（1~5）
  // ------------------------------------------------------------
  const buildTasks: PlanningTaskInput[] = [
    {
      id: "v_a",
      title: "无子任务任务",
      deadline: new Date("2026-10-25T18:00:00+08:00"),
      priority: "HIGH",
      status: "TODO",
      estimatedMinutes: 120,
      subTasks: [],
    },
    {
      id: "v_b",
      title: "有子任务任务",
      deadline: new Date("2026-10-25T18:00:00+08:00"),
      priority: "MEDIUM",
      status: "TODO",
      estimatedMinutes: 240,
      subTasks: [
        { id: "v_b1", title: "子任务一", estimatedMinutes: 90, status: "TODO", dependsOnIds: [] },
        { id: "v_b2", title: "子任务二", estimatedMinutes: 45, status: "DONE", dependsOnIds: ["v_b1"] },
        { id: "v_b3", title: "子任务三", estimatedMinutes: 60, status: "TODO", dependsOnIds: ["v_b2"] },
      ],
    },
    {
      id: "v_c",
      title: "已完成任务",
      deadline: new Date("2026-10-25T18:00:00+08:00"),
      priority: "LOW",
      status: "DONE",
      estimatedMinutes: 30,
      subTasks: [],
    },
    {
      id: "v_d",
      title: "已排期任务",
      deadline: new Date("2026-10-25T18:00:00+08:00"),
      priority: "LOW",
      status: "TODO",
      estimatedMinutes: 30,
      subTasks: [],
    },
    {
      id: "v_e",
      title: "缺耗时任务",
      deadline: new Date("2026-10-25T18:00:00+08:00"),
      priority: "LOW",
      status: "TODO",
      estimatedMinutes: null,
      subTasks: [],
    },
  ];

  const build = buildPlanningItems(buildTasks, new Set(["v_d"]));
  const byOwner = new Map(build.items.map((entry) => [entry.ownerId, entry]));

  const itemA = byOwner.get("v_a");
  check(
    "1. PlanningItem 构建正确（taskId/耗时/优先级/截止/依赖）",
    Boolean(
      itemA &&
        itemA.ownerType === "TASK" &&
        itemA.taskId === "v_a" &&
        itemA.estimatedMinutes === 120 &&
        itemA.priority === "HIGH" &&
        itemA.deadline === "2026-10-25T10:00:00.000Z" &&
        itemA.dependsOnOwnerIds.length === 0,
    ),
    JSON.stringify(itemA),
  );

  check(
    "2. 有子任务的 Task 不再作为父 Task 重复排期",
    !byOwner.has("v_b") && byOwner.has("v_b1") && byOwner.has("v_b3"),
    `items: ${[...byOwner.keys()].join(", ")}`,
  );

  check(
    "3. 无子任务 Task 可以直接排期",
    itemA?.ownerType === "TASK",
    itemA ? `${itemA.ownerType} ${itemA.ownerId}` : "缺失",
  );

  check(
    "4. 已完成任务/子任务不排期",
    !byOwner.has("v_c") &&
      !byOwner.has("v_b2") &&
      !build.unscheduled.some((entry) => entry.ownerId === "v_c" || entry.ownerId === "v_b2"),
  );

  check(
    "5. 无 deadline 的项进入 unscheduled 且原因明确",
    runPlan({ items: [item({ ownerId: "c5", deadline: null })] }).unscheduled.some(
      (entry) => entry.ownerId === "c5" && entry.reason.includes("缺少截止时间"),
    ),
  );

  // ------------------------------------------------------------
  // B. 确定性引擎约束（6~16）
  // ------------------------------------------------------------
  const c6 = runPlan({ items: [item({ ownerId: "c6", estimatedMinutes: 60 })] });
  check(
    "6. 不排到过去",
    c6.blocks.length === 1 &&
      c6.blocks.every((block) => new Date(block.startAt).getTime() >= NOW.getTime()),
    c6.blocks.map((block) => `${block.startAt}/${block.endAt}`).join(", "),
  );

  const c7a = runPlan({
    items: [
      item({
        ownerId: "c7a",
        estimatedMinutes: 60,
        deadline: "2026-10-21T12:00:00+08:00",
      }),
    ],
  });
  check(
    "7. 不超过 deadline",
    c7a.blocks.length === 1 &&
      c7a.blocks.every(
        (block) =>
          new Date(block.endAt).getTime() <=
          new Date("2026-10-21T12:00:00+08:00").getTime(),
      ),
    c7a.blocks.map((block) => `${block.startAt}/${block.endAt}`).join(", "),
  );

  const c7b = runPlan({
    items: [
      item({
        ownerId: "c7b",
        estimatedMinutes: 180,
        deadline: "2026-10-21T09:30:00+08:00",
      }),
    ],
  });
  check(
    "7b. 截止前时间不足时进入 unscheduled",
    c7b.blocks.length === 0 &&
      c7b.unscheduled.some((entry) => entry.reason.includes("截止时间前没有足够的空闲时段")),
    c7b.unscheduled[0]?.reason ?? "无原因",
  );

  const c8 = runPlan({
    items: [
      item({
        ownerId: "c8",
        estimatedMinutes: 120,
        deadline: "2026-10-21T23:59:00+08:00",
      }),
    ],
  });
  check(
    "8. 不与固定课程重叠",
    c8.blocks.length === 1 &&
      c8.blocks.every((block) => {
        const start = minuteOfDay(new Date(block.startAt));
        const weekday = weekdayOf(new Date(block.startAt));
        const end = start + durationOf(block);
        return COURSES.every(
          (course) =>
            course.dayOfWeek !== weekday ||
            !intervalsOverlap(start, end, course.startMinute, course.endMinute),
        );
      }),
    c8.blocks.map((block) => `${block.startAt}/${block.endAt}`).join(", "),
  );

  const busy10 = {
    startAt: shanghaiDate(2026, 10, 21, 10, 0),
    endAt: shanghaiDate(2026, 10, 21, 11, 0),
    label: "已有日程",
  };
  const c9 = runPlan({ items: [item({ ownerId: "c9", estimatedMinutes: 60 })], busy: [busy10] });
  check(
    "9. 不与已有 Schedule 重叠",
    c9.blocks.length === 1 &&
      !intervalsOverlap(
        new Date(c9.blocks[0].startAt).getTime(),
        new Date(c9.blocks[0].endAt).getTime(),
        busy10.startAt.getTime(),
        busy10.endAt.getTime(),
      ),
    c9.blocks.map((block) => `${block.startAt}/${block.endAt}`).join(", "),
  );

  const c10 = runPlan({
    items: [
      item({ ownerId: "c10a", estimatedMinutes: 60, deadline: "2026-10-22T18:00:00+08:00" }),
      item({ ownerId: "c10b", estimatedMinutes: 60, deadline: "2026-10-22T18:00:00+08:00" }),
    ],
  });
  const noOverlap = c10.blocks.every((a, i) =>
    c10.blocks.every(
      (b, j) =>
        i === j ||
        !intervalsOverlap(
          new Date(a.startAt).getTime(),
          new Date(a.endAt).getTime(),
          new Date(b.startAt).getTime(),
          new Date(b.endAt).getTime(),
        ),
    ),
  );
  check("10. preview 内部 block 之间不重叠", c10.blocks.length === 2 && noOverlap);

  const busy9 = {
    startAt: shanghaiDate(2026, 10, 21, 9, 0),
    endAt: shanghaiDate(2026, 10, 21, 10, 0),
    label: "已有日程",
  };
  const c11 = runPlan({ items: [item({ ownerId: "c11", estimatedMinutes: 30 })], busy: [busy9] });
  const c11Start = c11.blocks[0] ? minuteOfDay(new Date(c11.blocks[0].startAt)) : -1;
  check(
    "11. [start,end) 边界相接不算冲突",
    c11Start === 600 && !intervalsOverlap(540, 600, 600, 630),
    `block 起点 ${c11Start}`,
  );

  const c13 = runPlan({ items: [item({ ownerId: "c13", estimatedMinutes: 180 })] });
  const c13Total = c13.blocks.reduce((sum, block) => sum + durationOf(block), 0);
  check(
    "12. 30 分钟粒度正确",
    c13.blocks.every((block) => {
      const start = minuteOfDay(new Date(block.startAt));
      return start % PLAN_GRID_MINUTES === 0 && durationOf(block) % PLAN_GRID_MINUTES === 0;
    }),
    c13.blocks.map((block) => `${block.startAt}/${durationOf(block)}min`).join(", "),
  );

  const c13b = runPlan({ items: [item({ ownerId: "c13b", estimatedMinutes: 250 })] });
  const c13bTotal = c13b.blocks.reduce((sum, block) => sum + durationOf(block), 0);
  check(
    "13. 长任务拆块后总时长正确（单块 ≤ 120）",
    c13Total === 180 &&
      c13.blocks.length === 2 &&
      c13bTotal === 270 &&
      c13b.blocks.every((block) => durationOf(block) <= 120),
    `180→${c13.blocks.map(durationOf).join("+")}=${c13Total}；250→${c13b.blocks.map(durationOf).join("+")}=${c13bTotal}`,
  );

  const c14 = runPlan({
    items: [
      item({ ownerId: "c14a", ownerType: "SUBTASK", estimatedMinutes: 60, taskId: "t14" }),
      item({
        ownerId: "c14b",
        ownerType: "SUBTASK",
        estimatedMinutes: 30,
        taskId: "t14",
        dependsOnOwnerIds: ["c14a"],
      }),
    ],
  });
  const c14a = c14.blocks.find((block) => block.ownerId === "c14a");
  const c14b = c14.blocks.find((block) => block.ownerId === "c14b");
  check(
    "14. 单一依赖顺序正确",
    Boolean(c14a && c14b) &&
      new Date(c14b!.startAt).getTime() >= new Date(c14a!.endAt).getTime(),
    c14a && c14b ? `${c14a.endAt} ≤ ${c14b.startAt}` : "缺少计划块",
  );

  const c15 = runPlan({
    items: [
      item({ ownerId: "c15a", ownerType: "SUBTASK", estimatedMinutes: 60, taskId: "t15" }),
      item({ ownerId: "c15b", ownerType: "SUBTASK", estimatedMinutes: 60, taskId: "t15" }),
      item({
        ownerId: "c15c",
        ownerType: "SUBTASK",
        estimatedMinutes: 30,
        taskId: "t15",
        dependsOnOwnerIds: ["c15a", "c15b"],
      }),
    ],
  });
  const c15a = c15.blocks.find((block) => block.ownerId === "c15a");
  const c15b = c15.blocks.find((block) => block.ownerId === "c15b");
  const c15c = c15.blocks.find((block) => block.ownerId === "c15c");
  const readyC = Math.max(
    c15a ? new Date(c15a.endAt).getTime() : 0,
    c15b ? new Date(c15b.endAt).getTime() : 0,
  );
  check(
    "15. 多前置依赖顺序正确",
    Boolean(c15a && c15b && c15c) && new Date(c15c!.startAt).getTime() >= readyC,
    c15c ? `${new Date(readyC).toISOString()} ≤ ${c15c.startAt}` : "缺少计划块",
  );

  const deterministicInput = {
    items: [
      item({ ownerId: "c16a", ownerType: "SUBTASK", estimatedMinutes: 90, taskId: "t16" }),
      item({
        ownerId: "c16b",
        ownerType: "SUBTASK",
        estimatedMinutes: 30,
        taskId: "t16",
        dependsOnOwnerIds: ["c16a"],
      }),
    ],
  };
  check(
    "16. 同一输入重复运行结果确定一致",
    JSON.stringify(runPlan(deterministicInput)) === JSON.stringify(runPlan(deterministicInput)),
  );

  // ------------------------------------------------------------
  // C. 确认计划与事务（17~22）
  // ------------------------------------------------------------
  await cleanup();

  await prisma.course.create({
    data: {
      id: COURSE_ID,
      title: "验证用课程",
      dayOfWeek: 5,
      startMinute: 840,
      endMinute: 940,
      location: "验证楼",
    },
  });

  const makeTask = (id: string, deadline: string, priority = "HIGH") =>
    prisma.task.create({
      data: {
        id,
        title: `验证任务 ${id}`,
        deadline: new Date(deadline),
        priority,
        estimatedMinutes: 60,
        status: "TODO",
      },
    });

  await makeTask(TASK_IDS.a, "2026-10-25T18:00:00+08:00");
  await makeTask(TASK_IDS.b, "2026-10-25T18:00:00+08:00");
  await makeTask(TASK_IDS.c, "2026-10-22T18:00:00+08:00");
  await makeTask(TASK_IDS.d, "2026-10-25T18:00:00+08:00");

  function blockFor(
    ownerId: string,
    startAt: string,
    endAt: string,
  ): PlanBlock {
    return {
      clientId: `blk-${ownerId}-1`,
      ownerType: "TASK",
      ownerId,
      title: `验证任务 ${ownerId}`,
      startAt,
      endAt,
      rationale: `验证用理由：截止时间在前，该时段无课程与已有日程占用。`,
    };
  }

  const validPayload = {
    rangeStart: RANGE_START.toISOString(),
    rangeEnd: RANGE_END.toISOString(),
    blocks: [blockFor(TASK_IDS.a, "2026-10-23T10:00:00+08:00", "2026-10-23T11:00:00+08:00")],
    unscheduled: [],
  };

  const confirmed = await confirmPlan(validPayload, NOW);
  const storedA = await prisma.schedule.findFirst({
    where: { taskId: TASK_IDS.a, status: "CONFIRMED" },
  });
  check(
    "17. confirm 可以写入 Schedule（status=CONFIRMED，保留 rationale）",
    confirmed.scheduleCount === 1 &&
      Boolean(storedA) &&
      storedA!.rationale === validPayload.blocks[0].rationale,
    `scheduleCount=${confirmed.scheduleCount}`,
  );

  const planLog = await prisma.decisionLog.findFirst({
    where: { actionType: "PLAN", relatedTaskId: TASK_IDS.a },
  });
  let evidenceOk = false;
  try {
    const parsed = JSON.parse(planLog?.evidence ?? "{}") as { blocks?: unknown[] };
    evidenceOk = Array.isArray(parsed.blocks) && parsed.blocks.length === 1;
  } catch {
    evidenceOk = false;
  }
  check(
    "18. confirm 创建 DecisionLog(PLAN) 并记录依据",
    Boolean(planLog) && evidenceOk && confirmed.decisionLogIds.length === 1,
    planLog?.outputSummary ?? "缺少决策日志",
  );

  await expectCode(
    "19. 二次确认相同 owner 被拒绝",
    () => confirmPlan(validPayload, NOW),
    "ALREADY_SCHEDULED",
  );

  await expectCode(
    "20. 非法篡改 block（与课程重叠）被拒绝",
    () =>
      confirmPlan(
        {
          rangeStart: RANGE_START.toISOString(),
          rangeEnd: RANGE_END.toISOString(),
          blocks: [blockFor(TASK_IDS.b, "2026-10-23T14:30:00+08:00", "2026-10-23T15:30:00+08:00")],
          unscheduled: [],
        },
        NOW,
      ),
    "COURSE_OVERLAP",
  );

  await expectCode(
    "21. 非法篡改 block（超过 deadline）被拒绝",
    () =>
      confirmPlan(
        {
          rangeStart: RANGE_START.toISOString(),
          rangeEnd: RANGE_END.toISOString(),
          blocks: [blockFor(TASK_IDS.c, "2026-10-23T10:00:00+08:00", "2026-10-23T11:00:00+08:00")],
          unscheduled: [],
        },
        NOW,
      ),
    "DEADLINE_EXCEEDED",
  );

  let rollbackError = "";
  try {
    await prisma.$transaction(async (tx) => {
      await writePlan(tx, {
        blocks: [
          {
            ownerType: "TASK",
            ownerId: TASK_IDS.d,
            taskId: TASK_IDS.d,
            title: `验证任务 ${TASK_IDS.d}`,
            startAt: "2026-10-23T11:00:00+08:00",
            endAt: "2026-10-23T12:00:00+08:00",
            rationale: "事务回滚验证",
          },
        ],
        rangeStart: RANGE_START,
        rangeEnd: RANGE_END,
        unscheduledByTask: new Map(),
        strategy: "验证用策略",
      });
      throw new Error("注入失败");
    });
  } catch (error) {
    rollbackError = (error as Error).message;
  }
  const rolledBackSchedules = await prisma.schedule.count({
    where: { taskId: TASK_IDS.d },
  });
  const rolledBackLogs = await prisma.decisionLog.count({
    where: { relatedTaskId: TASK_IDS.d },
  });
  check(
    "22. transaction 失败不留下半套 Schedule / DecisionLog",
    rollbackError === "注入失败" && rolledBackSchedules === 0 && rolledBackLogs === 0,
    `schedules=${rolledBackSchedules}, logs=${rolledBackLogs}`,
  );

  // ------------------------------------------------------------
  // D. 清理（23）
  // ------------------------------------------------------------
  await cleanup();
  const leftovers = {
    tasks: await prisma.task.count({ where: { id: { startsWith: PREFIX } } }),
    courses: await prisma.course.count({ where: { id: { startsWith: PREFIX } } }),
    schedules: await prisma.schedule.count({
      where: { taskId: { startsWith: PREFIX } },
    }),
    logs: await prisma.decisionLog.count({
      where: { relatedTaskId: { startsWith: PREFIX } },
    }),
  };
  check(
    "23. 验证结束后清理测试数据，不污染正式数据",
    leftovers.tasks === 0 &&
      leftovers.courses === 0 &&
      leftovers.schedules === 0 &&
      leftovers.logs === 0,
    JSON.stringify(leftovers),
  );

  console.log(failed ? "\nS4 verification FAILED" : "\nS4 verification PASSED");
  if (failed) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("S4 verification crashed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
