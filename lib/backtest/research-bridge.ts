import type { Approval } from "./approvals";
import { compareRuns, decodeRun, type FrozenRun } from "./baseline";
import { parseApprovalId } from "./research-access";

export type ApprovalSummary = Pick<Approval, "baselineRunId" | "fast" | "status">;
export const approvalIdOf = ({ baselineRunId, fast }: Pick<Approval, "baselineRunId" | "fast">) => `${baselineRunId}-${fast}`;

async function worker(token: string, path: string, body?: object) {
  try {
    const upstream = await fetch(`http://127.0.0.1:30143${path}`, {
      method: body ? "POST" : "GET", signal: AbortSignal.timeout(7000), redirect: "error", cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, ...(body && { "Content-Type": "application/json" }) },
      body: body && JSON.stringify(body),
    });
    if (![200, 202, 400, 404, 409, 429].includes(upstream.status)) throw new Error("Worker unavailable");
    return Response.json(await upstream.json(), { status: upstream.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export function approvalWorker(token: string, id?: string, body?: { baselineRunId: string; fast: string }, report = false) {
  if (id !== undefined && !parseApprovalId(id)) return Promise.resolve(Response.json({ error: "invalid" }, { status: 400 }));
  const path = id === undefined ? "/internal/approvals" : `/internal/approvals/${id}${report ? "/report" : ""}`;
  return worker(token, path, body);
}

export type ChatAction = "message" | "decision" | "stop" | "reset";
export function chatWorker(token: string, action?: ChatAction, body?: object) {
  return worker(token, `/internal/research-chat${action ? `/${action}` : ""}`, body);
}

export async function approvalView(token: string, baseline: FrozenRun, approvalId?: string) {
  const target = approvalId ? parseApprovalId(approvalId) : null;
  const [index, detail] = await Promise.all([
    approvalWorker(token),
    target?.baselineRunId === baseline.runId ? approvalWorker(token, approvalId) : undefined,
  ]);
  const receipts: ApprovalSummary[] = index.ok ? (await index.json()).receipts : [];
  const current: Approval | undefined = detail?.ok ? await detail.json() : undefined;
  let variant: FrozenRun | undefined;
  if (current?.runId && approvalId) {
    try {
      const payload = await approvalWorker(token, approvalId, undefined, true);
      const report = payload.ok ? decodeRun(JSON.stringify((await payload.json()).report), "variant") : null;
      if (report && report.runId === current.runId && String(report.report.strategy.fast) === current.fast && compareRuns(baseline, report)) variant = report;
    } catch { /* Keep the receipt visible if its report cannot be loaded. */ }
  }
  return { receipts: receipts.filter((receipt) => receipt.baselineRunId === baseline.runId), current, variant, unavailable: !index.ok || detail?.status === 503 };
}
