import { NextResponse } from "next/server";

// 统一 JSON 响应出口：显式声明 UTF-8，
// 保证非浏览器客户端（如 PowerShell Invoke-RestMethod）正确解码中文
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export function jsonResponse(data: unknown, init?: { status?: number }): NextResponse {
  return NextResponse.json(data, {
    status: init?.status ?? 200,
    headers: JSON_HEADERS,
  });
}
