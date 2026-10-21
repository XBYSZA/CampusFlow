import { jsonResponse } from "@/lib/http";
import { decomposeTask, TaskError } from "@/lib/services/tasks";

/** POST /api/tasks/[id]/decompose —— 生成拆解预览，不写数据库 */
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const preview = await decomposeTask(id);
    return jsonResponse(preview);
  } catch (error) {
    if (error instanceof TaskError) {
      return jsonResponse(
        { error: error.message, code: error.code },
        { status: statusFor(error.code) },
      );
    }
    return jsonResponse({ error: "服务器内部错误" }, { status: 500 });
  }
}

/** 错误码 → HTTP 状态码：配置/超时/请求失败与业务校验问题要区分清楚 */
function statusFor(code: TaskError["code"]): number {
  switch (code) {
    case "TASK_NOT_FOUND":
      return 404;
    case "ALREADY_DECOMPOSED":
      return 409;
    case "AI_CONFIG_INVALID":
      return 503;
    case "AI_TIMEOUT":
      return 504;
    case "AI_REQUEST_FAILED":
    case "AI_RESPONSE_INVALID":
    case "PROVIDER_ERROR":
      return 502;
    default:
      return 422;
  }
}
