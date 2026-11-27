import { env } from "cloudflare:test";
import { creditsMigrations } from "@rolling/db/do/credits";
import { describe, expect, it } from "vitest";

describe("Durable Object stubs", () => {
  it("CreditAccount migrates and answers ping()", async () => {
    const stub = env.CREDITS.get(env.CREDITS.idFromName("ws_test"));
    expect(await stub.ping()).toMatchObject({ ok: true, schemaVersion: creditsMigrations.length });
  });

  it("AgentSession migrates and answers ping()", async () => {
    const stub = env.AGENT.get(env.AGENT.idFromName("thr_test"));
    expect(await stub.ping()).toEqual({ ok: true, schemaVersion: 3 });
  });

  it("UserHub broadcast() reports zero sockets when nobody is connected", async () => {
    const stub = env.USER_HUB.get(env.USER_HUB.idFromName("usr_test"));
    expect(await stub.broadcast("notification", { text: "hi" })).toBe(0);
  });
});
