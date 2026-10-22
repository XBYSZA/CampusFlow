"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

// ============================================================
// 全局页面壳（S7）：统一三个核心页面的产品形态
// 左侧导航 + 内容区；窄屏时导航折叠为顶部横排。
// ============================================================

const NAV_ITEMS = [
  { href: "/inbox", label: "智能收件箱", description: "通知 → 任务" },
  { href: "/tasks", label: "任务板", description: "任务 → 步骤" },
  { href: "/schedule", label: "智能日程", description: "步骤 → 计划" },
];

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  const navLink = (item: (typeof NAV_ITEMS)[number]) => {
    const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
    return (
      <Link
        key={item.href}
        href={item.href}
        className={`rounded-lg px-3 py-2 transition ${
          active
            ? "bg-slate-900 text-white"
            : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        }`}
      >
        <span className="block text-sm font-medium">{item.label}</span>
        <span
          className={`mt-0.5 hidden text-[11px] md:block ${
            active ? "text-slate-300" : "text-slate-400"
          }`}
        >
          {item.description}
        </span>
      </Link>
    );
  };

  return (
    <div className="flex min-h-screen flex-1 flex-col md:flex-row">
      {/* 侧边导航（窄屏折叠为顶部横排） */}
      <aside className="shrink-0 border-b border-slate-200 bg-white md:w-52 md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 px-4 py-4 md:flex-col md:items-stretch md:gap-1">
          <Link href="/" className="group mr-2 md:mb-4 md:mr-0">
            <span className="block text-base font-bold tracking-tight text-slate-900 group-hover:text-slate-600">
              CampusFlow
            </span>
            <span className="hidden text-[11px] text-slate-400 md:block">
              可解释的校园行动助手
            </span>
          </Link>
          <nav className="flex flex-1 gap-1 overflow-x-auto md:flex-col md:overflow-visible">
            {NAV_ITEMS.map(navLink)}
          </nav>
        </div>
      </aside>

      {/* 内容区：各页面自带标题与说明 */}
      <div className="flex min-w-0 flex-1 flex-col bg-slate-50/40">{children}</div>
    </div>
  );
}
