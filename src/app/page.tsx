import Link from "next/link";

// ============================================================
// 产品入口首页（S7）：不做复杂 Dashboard，只提供三个核心入口
// ============================================================

const ENTRIES = [
  {
    href: "/inbox",
    title: "信息收件箱",
    description: "粘贴校园通知，AI 提取任务与截止时间，每条结论都能追溯到原文。",
    tag: "AI · 信息理解",
  },
  {
    href: "/tasks",
    title: "任务拆解",
    description: "把复杂任务拆成有序、有依赖的执行步骤，确认后才入库。",
    tag: "AI · 任务拆解",
  },
  {
    href: "/schedule",
    title: "智能日程",
    description: "确定性规则引擎排期：避开课程与冲突，每个时间块都有理由。",
    tag: "规则引擎 · 排期",
  },
];

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">CampusFlow</h1>
      <p className="mt-2 text-base text-slate-600">
        把校园信息变成可解释的行动计划。
      </p>
      <p className="mt-1 text-sm text-slate-400">
        AI 负责理解与拆解，规则引擎负责排期与重排，每一步都由你确认，每个决定都能解释。
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {ENTRIES.map((entry) => (
          <Link
            key={entry.href}
            href={entry.href}
            className="group flex flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-400 hover:shadow"
          >
            <span className="text-[11px] font-medium text-slate-400">{entry.tag}</span>
            <span className="mt-1 text-base font-semibold text-slate-900 group-hover:text-slate-700">
              {entry.title}
            </span>
            <span className="mt-2 text-xs leading-5 text-slate-500">{entry.description}</span>
            <span className="mt-3 text-xs font-medium text-slate-900">进入 →</span>
          </Link>
        ))}
      </div>
    </main>
  );
}
