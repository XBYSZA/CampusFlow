import { connection } from "next/server";
import { jsonResponse } from "@/lib/http";
import { generateReplanPreview, ReplanError } from "@/lib/services/replan";

/**
 * POST /api/schedule/replan-preview
 * 基于当前未解决冲突生成重排预览（不写库）。
 * body 可选：{}（服务端自动使用所有未解决冲突）
 */
export async function POST(req: Request) {
  await connection();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const input =
    typeof body === "object" && body !== null
      ? (body as { conflictIds?: unknown })
      : {};

  const conflictIds =
    Array.isArray(input.conflictIds) && input.conflictIds.every((id) => typeof id === "string")
      ? (input.conflictIds as string[])
      : undefined;

  try {
    const preview = await generateReplanPreview(conflictIds);
    return jsonResponse({ preview });
  } catch (error) {
    if (error instanceof ReplanError) {
      const status =
        error.code === "NO_UNRESOLVED_CONFLICTS" || error.code === "VALIDATION_FAILED" ? 422 : 400;
      return jsonResponse({ error: error.message, code: error.code }, { status });
    }
    return jsonResponse({ error: "服务器内部错误" }, { status: 500 });
  }
}
