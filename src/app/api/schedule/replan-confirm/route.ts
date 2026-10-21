import { connection } from "next/server";
import { jsonResponse } from "@/lib/http";
import { confirmReplan, ReplanError, type ConfirmReplanInput } from "@/lib/services/replan";

/**
 * POST /api/schedule/replan-confirm
 * 确认重排：重新查询并校验全部约束，再事务写入。
 * body: { conflictIds: string[], blocks: PlanBlock[], rangeStart: ISO, rangeEnd: ISO }
 */
export async function POST(req: Request) {
  await connection();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const input =
    typeof body === "object" && body !== null
      ? (body as Partial<ConfirmReplanInput>)
      : {};

  if (
    !Array.isArray(input.conflictIds) ||
    !Array.isArray(input.blocks) ||
    typeof input.rangeStart !== "string" ||
    typeof input.rangeEnd !== "string"
  ) {
    return jsonResponse(
      { error: "缺少必填字段：conflictIds / blocks / rangeStart / rangeEnd", code: "VALIDATION_FAILED" },
      { status: 400 },
    );
  }

  try {
    const result = await confirmReplan({
      conflictIds: input.conflictIds as string[],
      blocks: input.blocks as ConfirmReplanInput["blocks"],
      rangeStart: input.rangeStart,
      rangeEnd: input.rangeEnd,
    });
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof ReplanError) {
      const status =
        error.code === "VALIDATION_FAILED" ||
        error.code === "CONFLICT_ALREADY_RESOLVED" ||
        error.code === "BLOCK_INVALID" ||
        error.code === "DURATION_MISMATCH" ||
        error.code === "DEPENDENCY_VIOLATION"
          ? 422
          : 400;
      return jsonResponse({ error: error.message, code: error.code }, { status });
    }
    return jsonResponse({ error: "服务器内部错误" }, { status: 500 });
  }
}
