import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import type { FrozenRun } from "./baseline";
import { parseTrialPeriod } from "./trial";

const id = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const states = ["running", "completed", "failed", "interrupted"] as const;
export type Approval = {
  baselineRunId: string;
  fast: string;
  status: typeof states[number];
  approvedAt: string;
  runId?: string;
  reportSha256?: string;
  model?: string;
  answer?: string;
  completedTools?: string[];
};
type Outcome = { runId: string; answer: string; completedTools: string[] };
export type ApprovalTicket = { status: "accepted"; recordRun: (runId: string, reportSha256?: string) => void; complete: (outcome: Outcome) => void; fail: () => void };
type Execute = (fast: string, recordRun: ApprovalTicket["recordRun"]) => Promise<Outcome>;

// Single writer: the loopback server starts recovery only after acquiring its fixed port.
export function createApprovalStore({ directory, baseline, executor, model }: { directory: string; baseline: FrozenRun; executor: Execute; model?: string }) {
  const baselineRunId = baseline.runId;
  if (!id(baselineRunId)) throw new Error("Invalid baseline ID.");
  const periods = ["1", "2", "3", "4", "5", "6", "7"].filter((fast) => parseTrialPeriod(fast, baseline) !== null);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = (fast: string) => join(directory, `${baselineRunId}-${fast}.json`);
  let active = false;
  const write = (receipt: Approval) => writePrivateFileAtomicSync(path(receipt.fast), JSON.stringify(receipt));

  function get(fast: string): Approval | undefined {
    if (!periods.includes(fast)) return undefined;
    try {
      const receipt = JSON.parse(readFileSync(path(fast), "utf8")) as Approval | null;
      if (receipt?.baselineRunId !== baselineRunId || receipt.fast !== fast || !states.includes(receipt.status) ||
          typeof receipt.approvedAt !== "string" || (receipt.runId !== undefined && !id(receipt.runId)) ||
          (receipt.reportSha256 !== undefined && (!id(receipt.reportSha256) || !receipt.runId))) {
        throw new Error("Invalid approval receipt.");
      }
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  }

  function list() { return periods.map(get).filter((receipt) => receipt !== undefined); }
  function recoverInterrupted() {
    if (active) throw new Error("Cannot recover while Pi is active.");
    for (const receipt of list()) if (receipt.status === "running") write({ ...receipt, status: "interrupted" });
  }

  function reserve(fast: string): ApprovalTicket | { status: "invalid" | "exists" | "busy" } {
    if (!periods.includes(fast)) return { status: "invalid" };
    if (get(fast)) return { status: "exists" };
    if (active || list().some((r) => r.status === "running")) return { status: "busy" };
    write({ baselineRunId, fast, status: "running", approvedAt: new Date().toISOString(), model });
    active = true;
    let open = true;
    const finish = (update: Pick<Approval, "status" | "answer" | "completedTools">) => {
      if (!open) return;
      try {
        const current = get(fast);
        if (current?.status === "running") write({ ...current, ...update });
      } finally { open = false; active = false; }
    };
    return {
      status: "accepted",
      recordRun(runId, reportSha256) {
        const current = get(fast);
        if (!open || current?.status !== "running" || !id(runId) || (reportSha256 !== undefined && !id(reportSha256)) ||
          (current.runId && (current.runId !== runId || current.reportSha256 !== reportSha256))) throw new Error("Mismatched trial receipt.");
        if (!current.runId) write({ ...current, runId, reportSha256 });
      },
      complete(outcome) {
        if (get(fast)?.runId !== outcome.runId) throw new Error("Completion without a matching run receipt.");
        finish({ status: "completed", answer: outcome.answer, completedTools: outcome.completedTools });
      },
      fail() { finish({ status: "failed" }); },
    };
  }

  function approve(fast: string) {
    const ticket = reserve(fast);
    if (ticket.status === "accepted") {
      void Promise.resolve().then(() => executor(fast, ticket.recordRun)).then(ticket.complete).catch(ticket.fail).catch(() => {
        // A disk error leaves the last receipt intact and blocks new approvals until recovery.
        console.error("Could not update the Pi research receipt.");
      });
    }
    return ticket.status;
  }
  return { baselineRunId, periods, get, list, approve, reserve, recoverInterrupted };
}
