import { env, SELF } from "cloudflare:test";
import { expect } from "vitest";
import { RecordingEmailProvider } from "@rolling/core/email/recording";

export const BASE = "https://example.com";
/** PUBLIC_APP_URL in the test config; Better Auth checks Origin against it. */
export const ORIGIN = "http://localhost:8787";

let ipSeq = 0;
/** A fresh client IP per call, so per-IP limits do not leak between tests. */
export function freshIp(): string {
  ipSeq++;
  return `198.51.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
}

let emailSeq = 0;
export function freshEmail(tag = "user"): string {
  emailSeq++;
  return `${tag}.${Date.now().toString(36)}.${emailSeq}@example.com`;
}

export function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body: JSON.stringify(body) };
}

export async function sendCode(email: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${BASE}/api/auth/email-otp/send-verification-otp`, json({ email, type: "sign-in" }, headers));
}

/** Waits for the `notify-email` consumer to deliver a message to `email`. */
export async function waitForEmail(email: string, count = 1, timeoutMs = 15_000): Promise<{ subject: string; text: string }[]> {
  const start = Date.now();
  for (;;) {
    const msgs = RecordingEmailProvider.to(email);
    if (msgs.length >= count) return msgs;
    if (Date.now() - start > timeoutMs) throw new Error(`no email to ${email} after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function codeFrom(text: string): string {
  const m = /\b(\d{6})\b/.exec(text);
  if (!m) throw new Error(`no code in: ${text}`);
  return m[1]!;
}

/** Cookie header value ("name=value; ...") from a response's Set-Cookie headers. */
export function cookieFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");
}

/** Full email-code sign-in; returns the session cookie. */
export async function signIn(email: string, headers: Record<string, string> = {}): Promise<{ cookie: string; res: Response }> {
  const before = RecordingEmailProvider.to(email).length;
  const sent = await sendCode(email, headers);
  expect(sent.status, await sent.clone().text()).toBe(200);
  const msgs = await waitForEmail(email, before + 1);
  const code = codeFrom(msgs[msgs.length - 1]!.text);
  const res = await SELF.fetch(`${BASE}/api/auth/sign-in/email-otp`, json({ email, otp: code }, headers));
  expect(res.status, await res.clone().text()).toBe(200);
  return { cookie: cookieFrom(res), res };
}

export async function getMe(cookie: string, headers: Record<string, string> = {}) {
  const res = await SELF.fetch(`${BASE}/api/me`, { headers: { cookie, ...headers } });
  return { res, body: (await res.json()) as any };
}

export async function grantPlan(workspaceId: string, plan: "starter" | "plus" | "pro" | "team" = "pro", status = "active", seats = 1): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO subscriptions (id, workspace_id, plan, interval, status, current_period_end, updated_at, seats) VALUES (?1, ?2, ?3, 'month', ?4, ?5, 0, ?6)",
  )
    .bind(`sub_${crypto.randomUUID()}`, workspaceId, plan, status, Date.now() + 30 * 86_400_000, seats)
    .run();
}
