import "dotenv/config";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
// 一键重置演示数据库（S9）：npm run db:demo
//
// 流程：校验 DATABASE_URL → 删除本地 dev.db → migrate deploy → seed → demo fixture
//
// 安全保护：
// - 只允许操作项目内唯一确定路径 prisma/dev.db；
// - DATABASE_URL 指向其他任何位置（远程、测试库、未知路径、非 file: 协议）
//   一律拒绝执行并报 DEMO_RESET_UNSAFE_DATABASE；
// - 只删除明确列出的 dev.db 及其 SQLite 附属文件，不使用模糊匹配；
// - 不修改 schema、不影响 migration 历史、不触碰 .env。
// ============================================================

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_DB_PATH = path.normalize(path.join(PROJECT_ROOT, "prisma", "dev.db"));
const DB_FILE_SUFFIXES = ["", "-journal", "-wal", "-shm"];

/**
 * 将 DATABASE_URL 解析为绝对路径。
 * Prisma 对 SQLite 相对路径以 schema 所在目录（prisma/）为基准，
 * 因此 "file:./dev.db" 与 "file:./prisma/dev.db" 都等价于 prisma/dev.db。
 * 无法安全解析时返回 null。
 */
function resolveDatabasePath(databaseUrl: string): string | null {
  if (!databaseUrl.startsWith("file:")) return null;
  const rawPath = databaseUrl.slice("file:".length);
  if (!rawPath || rawPath.includes("?") || rawPath.includes("*")) return null;

  const candidates = path.isAbsolute(rawPath)
    ? [path.normalize(rawPath)]
    : [
        path.normalize(path.resolve(PROJECT_ROOT, rawPath)),
        path.normalize(path.resolve(PROJECT_ROOT, "prisma", rawPath)),
      ];
  return candidates.find((candidate) => candidate === EXPECTED_DB_PATH) ?? null;
}

const databaseUrl = process.env.DATABASE_URL ?? "file:./prisma/dev.db";
const resolvedPath = resolveDatabasePath(databaseUrl);

if (resolvedPath === null) {
  console.error("[demo] DEMO_RESET_UNSAFE_DATABASE");
  console.error("[demo] demo 只允许重置项目本地开发数据库 prisma/dev.db。");
  console.error("[demo] 当前 DATABASE_URL 无法确认为该路径，已拒绝执行（未做任何修改）。");
  process.exit(1);
}

function runStep(command: string): void {
  execSync(command, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

console.log("[demo] 目标数据库已确认：prisma/dev.db");

for (const suffix of DB_FILE_SUFFIXES) {
  rmSync(`${EXPECTED_DB_PATH}${suffix}`, { force: true });
}
console.log("[demo] 已清除旧的 dev.db（仅 prisma/dev.db 及其 SQLite 附属文件）");

runStep("npx prisma migrate deploy");
runStep("npx prisma db seed");
runStep("npx tsx scripts/demo-fixture.ts");

console.log("[demo] 演示数据库重置完成。");
