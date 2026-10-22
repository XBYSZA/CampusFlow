import "dotenv/config";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
// S7 验证包装器：在独立临时 SQLite 数据库上运行 verify-s7.ts
//
// 目的：s7:verify 不依赖、不修改、不污染开发数据库 prisma/dev.db
// 流程：清理残留 → migrate deploy → db seed → 运行验证 → 清理临时库
//
// 临时库文件名以 dev.db 开头，已被 .gitignore 的 `prisma/dev.db*` 覆盖。
// 无论验证 PASS 还是 FAIL，finally 都会删除临时库及其附属文件。
// ============================================================

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_RELATIVE_PATH = "prisma/dev.db.s7-verify";
const DATABASE_URL = `file:./${DB_RELATIVE_PATH}`;
const DB_ABSOLUTE_PATH = path.join(PROJECT_ROOT, DB_RELATIVE_PATH);
const DB_FILE_SUFFIXES = ["", "-journal", "-wal", "-shm"];

function removeDatabaseFiles(): void {
  for (const suffix of DB_FILE_SUFFIXES) {
    try {
      rmSync(`${DB_ABSOLUTE_PATH}${suffix}`, { force: true });
    } catch (error) {
      console.warn(`[s7:verify] 清理临时库文件失败（${suffix || "main"}）：${(error as Error).message}`);
    }
  }
}

function runStep(command: string): void {
  execSync(command, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL },
  });
}

let exitCode = 0;

try {
  removeDatabaseFiles();
  console.log(`[s7:verify] 使用隔离数据库：${DB_RELATIVE_PATH}`);

  runStep("npx prisma migrate deploy");
  runStep("npx prisma db seed");
  runStep("npx tsx scripts/verify-s7.ts");
} catch (error) {
  const status = (error as { status?: number }).status;
  exitCode = typeof status === "number" && status > 0 ? status : 1;
  if (!status) {
    console.error(`[s7:verify] 隔离验证执行失败：${(error as Error).message}`);
  }
} finally {
  removeDatabaseFiles();
  console.log(`[s7:verify] 已清理隔离数据库：${DB_RELATIVE_PATH}`);
}

process.exitCode = exitCode;
