import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import type { FrozenRun } from "./baseline";
import { parseTrialPeriod } from "./trial";

const id = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const states = ["running", "completed", "failed", "interrupted"] as const;
type Approval = {
  baselineRunId: string;
  fast: string;
  status: typeof states[number];
  approvedAt: string;
  runId?: string;
  answer?: string;
  completedTools?: string[];
};
type Execute = (fast: string, recordRun: (runId: string) => void) => Promise<{ runId: string; answer: string; completedTools: string[] }>;

// Single writer: the loopback server starts recovery only after acquiring its fixed port.
export function createApprovalStore({ directory, baseline, executor }: { directory: string; baseline: FrozenRun; executor: Execute }) {
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
          typeof receipt.approvedAt !== "string" || (receipt.runId !== undefined && !id(receipt.runId))) {
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

  function approve(fast: string): "invalid" | "exists" | "busy" | "accepted" {
    if (!periods.includes(fast)) return "invalid";
    if (get(fast)) return "exists";
    if (active || list().some((r) => r.status === "running")) return "busy";
    write({ baselineRunId, fast, status: "running", approvedAt: new Date().toISOString() });
    active = true;
    const patch = (update: Pick<Approval, "status" | "answer" | "completedTools">) => {
      const current = get(fast);
      if (current?.status === "running") write({ ...current, ...update });
    };
    void Promise.resolve().then(async () => {
      const outcome = await executor(fast, (runId) => {
        const current = get(fast);
        if (current?.status !== "running" || !id(runId) || (current.runId && current.runId !== runId)) throw new Error("Mismatched trial receipt.");
        if (!current.runId) write({ ...current, runId });
      });
      if (get(fast)?.runId !== outcome.runId) throw new Error("Completion without a matching run receipt.");
      patch({ status: "completed", answer: outcome.answer, completedTools: outcome.completedTools });
    }).catch(() => patch({ status: "failed" })).catch(() => {
      // A disk error leaves the last receipt intact and blocks new approvals until recovery.
      console.error("Could not update the Pi research receipt.");
    }).finally(() => { active = false; });
    return "accepted";
  }
  return { baselineRunId, periods, get, list, approve, recoverInterrupted };
}
