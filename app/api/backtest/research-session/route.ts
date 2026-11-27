import { NextRequest, NextResponse } from "next/server";
import { createAuthThrottleState, getAuthRetryAfterMs, recordAuthFailure, recordAuthSuccess, retryAfterSeconds, type AuthThrottleState } from "@/lib/auth-throttle";
import { isValidWebPassword } from "@/lib/web-auth";
import { getResearchAccess, isResearchRequest, issueResearchSession, readSmallJson, RESEARCH_COOKIE, RESEARCH_MAX_AGE } from "@/lib/backtest/research-access";

// Single-operator research login, independently throttled from upstream Pi Web.
const key = Symbol.for("pi-backtest:research-auth-throttle");
const shared = globalThis as Record<PropertyKey, unknown>;
const throttle = (shared[key] ??= createAuthThrottleState()) as AuthThrottleState;
const json = (body: object, status = 200, headers?: HeadersInit) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const cookie = { name: RESEARCH_COOKIE, httpOnly: true, sameSite: "lax" as const, secure: true, path: "/" };

export async function POST(request: NextRequest) {
  const access = getResearchAccess();
  if (!access) return json({ error: "disabled" }, 404);
  if (!isResearchRequest(request.headers, access, true)) return json({ error: "forbidden" }, 403);
  const body = await readSmallJson(request);
  if (!body || Object.keys(body).length !== 1 || typeof body.password !== "string") return json({ error: "invalid" }, 400);
  const retry = getAuthRetryAfterMs(Date.now(), throttle);
  if (retry) return json({ error: "throttled" }, 429, { "Retry-After": String(retryAfterSeconds(retry)) });
  if (!isValidWebPassword(body.password, access.password)) {
    const wait = retryAfterSeconds(recordAuthFailure(Date.now(), throttle));
    return json({ error: "invalid_password" }, 401, { "Retry-After": String(wait) });
  }
  recordAuthSuccess(throttle);
  const reply = json({ ok: true });
  reply.cookies.set({ ...cookie, value: issueResearchSession(access), maxAge: RESEARCH_MAX_AGE });
  return reply;
}

export function DELETE(request: NextRequest) {
  const access = getResearchAccess();
  if (!access) return json({ error: "disabled" }, 404);
  if (!isResearchRequest(request.headers, access, true)) return json({ error: "forbidden" }, 403);
  const reply = json({ ok: true });
  reply.cookies.set({ ...cookie, value: "", maxAge: 0 });
  return reply;
}
