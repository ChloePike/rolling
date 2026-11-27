import { createMessageBatch, env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleNotifyEmail } from "../src/auth/email";
import type { SendEmailBinding } from "@rolling/core/email/cloudflare";
import { EMAIL_CATALOG } from "@rolling/core/email/catalog.gen";

type Sent = Parameters<SendEmailBinding["send"]>[0];

function binding(): SendEmailBinding & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
      return { messageId: `msg_${sent.length}` };
    },
  };
}

/** Fixture strings, so the test does not depend on the shipped translations. */
const FIXTURES: Record<string, Record<string, string>> = {
  ja: { "email.signInCode.subject": "JA {app} {code}", "email.footer.terms": "JA-terms" },
  ko: { "email.signInCode.subject": "KO {app} {code}" },
};
const saved: Record<string, Record<string, string> | undefined> = {};

beforeAll(async () => {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO users (id, name, email, email_verified, created_at, updated_at) VALUES ('usr_emailja', 'Aki', 'aki@example.com', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT OR REPLACE INTO user_prefs (user_id, language) VALUES ('usr_emailja', 'ja')"),
  ]);
  for (const [locale, strings] of Object.entries(FIXTURES)) {
    saved[locale] = EMAIL_CATALOG[locale];
    EMAIL_CATALOG[locale] = strings;
  }
});


async function send(body: Record<string, unknown>) {
  const EMAIL = binding();
  const batch = createMessageBatch("rolling-dev-notify-email", [{ id: `m${Math.random()}`, timestamp: new Date(), attempts: 1, body }]);
  await handleNotifyEmail(batch, { ...env, ENVIRONMENT: "production", EMAIL_PROVIDER: "cloudflare", EMAIL_FROM: "", EMAIL, PUBLIC_APP_URL: "https://rolling.actor" } as unknown as Env);
  expect(EMAIL.sent).toHaveLength(1);
  return EMAIL.sent[0]!;
}

describe("email localization (D-023)", () => {
  it("follows the recipient's saved language, over the request's hint, with English per missing key", async () => {
    const m = await send({ to: "Aki@example.com", template: "sign-in-code", data: { code: "246810", expiresInMinutes: 10 }, locale: "ko" });
    expect(m.subject).toBe("JA Rolling 246810");
    // Keys the locale has not translated stay English.
    expect(m.text).toContain("Your sign-in code is 246810.");
    expect(m.text).toContain("JA-terms: https://rolling.actor/terms");
    expect(m.html).toContain('<html lang="ja">');
    const byId = await send({ userId: "usr_emailja", template: "sign-in-code", data: { code: "246810", expiresInMinutes: 10 } });
    expect(byId.subject).toBe("JA Rolling 246810");
  });

  it("uses the hint for an address without an account, else English", async () => {
    expect((await send({ to: "new@example.com", template: "sign-in-code", data: { code: "112233", expiresInMinutes: 10 }, locale: "ko" })).subject).toBe("KO Rolling 112233");
    expect((await send({ to: "new@example.com", template: "sign-in-code", data: { code: "112233", expiresInMinutes: 10 }, locale: "de" })).subject).toBe("Your Rolling sign-in code is 112233");
    expect((await send({ to: "new@example.com", template: "sign-in-code", data: { code: "112233", expiresInMinutes: 10 } })).subject).toBe("Your Rolling sign-in code is 112233");
  });
});

// Restore the shipped catalog for other files in the same isolate.
afterAll(() => {
  for (const [locale, strings] of Object.entries(saved)) {
    if (strings) EMAIL_CATALOG[locale] = strings;
    else delete EMAIL_CATALOG[locale];
  }
});
