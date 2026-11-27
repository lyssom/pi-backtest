import { type NextRequest } from "next/server";
import { getResearchAccess, hasResearchSession, isResearchRequest, parseApprovalId, readSmallJson, RESEARCH_COOKIE } from "@/lib/backtest/research-access";
import { approvalWorker } from "@/lib/backtest/research-bridge";

const error = (status: number, code: string) => Response.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
type Context = { params: Promise<{ id?: string[] }> };

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
  const { id = [] } = await params;
  if (id.length > 1 || (id.length === 1 && !parseApprovalId(id[0]))) return error(404, "not_found");
  return approvalWorker(access.workerToken, id[0]);
}

export async function POST(request: NextRequest, { params }: Context) {
  const access = authorize(request, true);
  if (access instanceof Response) return access;
  if ((await params).id?.length) return error(404, "not_found");
  const body = await readSmallJson(request);
  if (!body || Object.keys(body).length !== 2 || typeof body.baselineRunId !== "string" || typeof body.fast !== "string" ||
      !parseApprovalId(`${body.baselineRunId}-${body.fast}`)) return error(400, "invalid");
  return approvalWorker(access.workerToken, undefined, { baselineRunId: body.baselineRunId, fast: body.fast });
}
