import type { NextRequest } from "next/server";
import { getResearchAccess, hasResearchSession, isResearchRequest, readSmallJson, RESEARCH_COOKIE } from "@/lib/backtest/research-access";
import { chatWorker, type ChatAction } from "@/lib/backtest/research-bridge";

type Context = { params: Promise<{ action?: string[] }> };
const error = (status: number, code: string) => Response.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
const allowed = (value: unknown): value is ChatAction => value === "message" || value === "decision" || value === "stop" || value === "reset";

function authorize(request: NextRequest, write: boolean) {
  const access = getResearchAccess();
  if (!access) return error(404, "disabled");
  if (!isResearchRequest(request.headers, access, write)) return error(403, "forbidden");
  if (!hasResearchSession(request.cookies.get(RESEARCH_COOKIE)?.value, access)) return error(401, "login_required");
  return access;
}

export async function GET(request: NextRequest, { params }: Context) {
  const access = authorize(request, false);
  if (access instanceof Response) return access;
  return (await params).action?.length ? error(404, "not_found") : chatWorker(access.workerToken);
}

export async function POST(request: NextRequest, { params }: Context) {
  const access = authorize(request, true);
  if (access instanceof Response) return access;
  const { action } = await params;
  if (action?.length !== 1 || !allowed(action[0])) return error(404, "not_found");
  const body = await readSmallJson(request, action[0] === "message" ? 8192 : 512);
  if (!body) return error(400, "invalid");
  return chatWorker(access.workerToken, action[0], body);
}
