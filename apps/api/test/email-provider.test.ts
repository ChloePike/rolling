import { createMessageBatch, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_EMAIL_FROM, emailProvider, emailProviderName, EMAIL_REPLY_TO, handleNotifyEmail } from "../src/auth/email";
import { getAuth } from "../src/auth/betterAuth";
import { CloudflareEmailProvider, type SendEmailBinding } from "@rolling/core/email/cloudflare";
import { ResendEmailProvider } from "@rolling/core/email/resend";
import { RecordingEmailProvider } from "@rolling/core/email/recording";

type Sent = Parameters<SendEmailBinding["send"]>[0];

/** A mocked `send_email` binding that records calls, or throws an Email Service error. */
function mockBinding(fail?: { code?: string; type?: "type" }): SendEmailBinding & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    async send(message) {
      if (fail?.type === "type") throw new TypeError("bad argument");
      if (fail) throw Object.assign(new Error(`failed: ${fail.code}`), { code: fail.code });
      sent.push(message);
      return { messageId: `msg_${sent.length}` };
    },
  };
}

const withEnv = (overrides: Record<string, unknown>) => ({ ...env, ...overrides }) as unknown as Env;

describe("email provider selection", () => {
  it("defaults to Cloudflare when the EMAIL binding exists (outside development)", () => {
    const EMAIL = mockBinding();
    for (const ENVIRONMENT of ["staging", "production"]) {
      expect(emailProviderName(withEnv({ ENVIRONMENT, EMAIL_PROVIDER: "", EMAIL }))).toBe("cloudflare");
      expect(emailProviderName(withEnv({ ENVIRONMENT, EMAIL_PROVIDER: "", EMAIL, RESEND_API_KEY: "re_x" }))).toBe("cloudflare");
    }
    expect(emailProvider(withEnv({ ENVIRONMENT: "production", EMAIL_PROVIDER: "cloudflare", EMAIL }))).toBeInstanceOf(CloudflareEmailProvider);
  });

  it("keeps development on the recording provider and Resend as the fallback", () => {
    expect(emailProviderName(withEnv({ ENVIRONMENT: "development", EMAIL_PROVIDER: "", EMAIL: mockBinding() }))).toBe("recording");
    expect(emailProviderName(withEnv({ ENVIRONMENT: "production", EMAIL_PROVIDER: "", EMAIL: undefined, RESEND_API_KEY: "re_x" }))).toBe("resend");
    expect(emailProvider(withEnv({ ENVIRONMENT: "production", EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x" }))).toBeInstanceOf(ResendEmailProvider);
    expect(emailProvider(withEnv({ ENVIRONMENT: "development", EMAIL_PROVIDER: "" }))).toBeInstanceOf(RecordingEmailProvider);
  });

  it("refuses a missing binding or key, unknown names and non-sending providers in production", async () => {
    expect(() => emailProvider(withEnv({ ENVIRONMENT: "production", EMAIL_PROVIDER: "cloudflare", EMAIL: undefined }))).toThrow(/EMAIL send_email binding/);
    expect(() => emailProvider(withEnv({ ENVIRONMENT: "production", EMAIL_PROVIDER: "resend", EMAIL: undefined }))).toThrow(/RESEND_API_KEY/);
    expect(() => emailProviderName(withEnv({ ENVIRONMENT: "production", EMAIL_PROVIDER: "", EMAIL: undefined }))).toThrow(/No email provider/);
    expect(() => emailProviderName(withEnv({ ENVIRONMENT: "staging", EMAIL_PROVIDER: "smtp" }))).toThrow(/not supported/);
    for (const name of ["test-inbox", "recording"]) {
      expect(() => emailProviderName(withEnv({ ENVIRONMENT: "production", EMAIL_PROVIDER: name, EMAIL: mockBinding() }))).toThrow(/refused in production/);
    }
    expect(emailProviderName(withEnv({ ENVIRONMENT: "staging", EMAIL_PROVIDER: "test-inbox", EMAIL: mockBinding() }))).toBe("test-inbox");
    await expect(
      getAuth(withEnv({ ENVIRONMENT: "production", EMAIL_PROVIDER: "cloudflare", EMAIL: mockBinding(), BETTER_AUTH_SECRET: "y".repeat(32) })),
    ).resolves.toBeTruthy();
  });

  it("sends through the binding with the configured sender and support reply-to", async () => {
    const EMAIL = mockBinding();
    const batch = createMessageBatch("rolling-dev-notify-email", [
      { id: "cf1", timestamp: new Date(), attempts: 1, body: { to: "person@example.com", template: "sign-in-code", data: { code: "135790", expiresInMinutes: 10 } } },
    ]);
    await handleNotifyEmail(batch, withEnv({ ENVIRONMENT: "production", EMAIL_PROVIDER: "cloudflare", EMAIL_FROM: "", EMAIL, PUBLIC_APP_URL: "https://rolling.actor" }));
    expect(EMAIL.sent).toHaveLength(1);
    const m = EMAIL.sent[0]!;
    expect(DEFAULT_EMAIL_FROM).toBe("Rolling <no-reply@rolling.actor>");
    expect(m.from).toEqual({ email: "no-reply@rolling.actor", name: "Rolling" });
    expect(m.replyTo).toBe(EMAIL_REPLY_TO);
    expect(m.to).toBe("person@example.com");
    expect(m.subject).toBe("Your Rolling sign-in code is 135790");
    expect(m.text).toContain("135790");
    expect(m.html).toContain("https://rolling.actor/privacy");
  });

  it("retries rate limits and drops validation errors", async () => {
    const message = { to: "x@example.com", subject: "s", text: "t", html: "h" };
    const send = (fail: Parameters<typeof mockBinding>[0]) =>
      new CloudflareEmailProvider({ binding: mockBinding(fail), from: DEFAULT_EMAIL_FROM }).send(message).then(
        () => ({ retryable: null as boolean | null }),
        (e: unknown) => ({ retryable: (e as { retryable: boolean }).retryable }),
      );
    expect((await send({ code: "E_RATE_LIMIT_EXCEEDED" })).retryable).toBe(true);
    expect((await send({ code: "E_EMAIL_SENDING_NOT_READY" })).retryable).toBe(true);
    expect((await send({ code: "E_VALIDATION_ERROR" })).retryable).toBe(false);
    expect((await send({ code: "E_RECIPIENT_SUPPRESSED" })).retryable).toBe(false);
    expect((await send({ type: "type" })).retryable).toBe(false);
  });
});
