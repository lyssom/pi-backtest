import { createHmac, randomBytes } from "node:crypto";
import { isValidWebPassword } from "../web-auth";

export const RESEARCH_COOKIE = "__Host-pi_backtest_research";
export const RESEARCH_MAX_AGE = 8 * 3600;

type ResearchAccess = { origin: string; host: string; password: string; workerToken: string };

export function getResearchAccess(env = process.env): ResearchAccess | null {
  const { PI_BACKTEST_RESEARCH_ORIGIN: input, PI_BACKTEST_RESEARCH_PASSWORD: password, PI_BACKTEST_WORKER_TOKEN: workerToken } = env;
  if (!input || !password || !workerToken || password.length < 24 || workerToken.length < 24 ||
      password === workerToken || password === env.PI_WEB_PASSWORD) return null;
  try {
    const url = new URL(input);
    return url.protocol === "https:" && url.origin === input ? { origin: input, host: url.host, password, workerToken } : null;
  } catch { return null; }
}

// The dedicated HTTPS proxy keeps Host and sets x-forwarded-proto itself; it must never pass client-supplied forwarding headers.
export function isResearchRequest(headers: Pick<Headers, "get">, access: ResearchAccess, write = false) {
  const site = headers.get("sec-fetch-site");
  const origin = headers.get("origin");
  return headers.get("host") === access.host && headers.get("x-forwarded-proto") === "https" &&
    (write ? origin === access.origin && (!site || site === "same-origin") : origin === null || origin === access.origin);
}

function sign(payload: string, password: string) {
  return createHmac("sha256", password).update(`pi-backtest-research-session:${payload}`).digest("hex");
}

export function issueResearchSession(access: ResearchAccess, now = Date.now()) {
  const payload = `v1.${Math.floor(now / 1000) + RESEARCH_MAX_AGE}.${randomBytes(16).toString("hex")}`;
  return `${payload}.${sign(payload, access.password)}`;
}

export function hasResearchSession(token: string | undefined, access: ResearchAccess, now = Date.now()) {
  const match = token && /^(v1\.(\d{1,12})\.[a-f0-9]{32})\.([a-f0-9]{64})$/.exec(token);
  return Boolean(match && Number(match[2]) > Math.floor(now / 1000) && isValidWebPassword(match[3], sign(match[1], access.password)));
}

export function parseApprovalId(value: unknown) {
  const match = typeof value === "string" && value.length === 66 ? /^([a-f0-9]{64})-([1-7])$/.exec(value) : null;
  return match ? { baselineRunId: match[1], fast: match[2] } : null;
}

export async function readSmallJson(request: Request, limit = 512): Promise<Record<string, unknown> | null> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
  const reader = request.body?.getReader();
  if (!reader || Number(request.headers.get("content-length")) > limit) return null;
  try {
    const buffer = new Uint8Array(limit);
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.byteLength > buffer.length) {
        void reader.cancel().catch(() => {});
        return null;
      }
      buffer.set(value, size);
      size += value.byteLength;
    }
    const json: unknown = JSON.parse(new TextDecoder().decode(buffer.subarray(0, size)));
    return json && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : null;
  } catch { return null; }
  finally { reader.releaseLock(); }
}
