import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Durable Object stubs", () => {
  it("CreditAccount migrates and answers ping()", async () => {
    const stub = env.CREDITS.get(env.CREDITS.idFromName("ws_test"));
    expect(await stub.ping()).toEqual({ ok: true, schemaVersion: 2 });
  });

  it("AgentSession migrates and answers ping()", async () => {
    const stub = env.AGENT.get(env.AGENT.idFromName("thr_test"));
    expect(await stub.ping()).toEqual({ ok: true, schemaVersion: 1 });
  });

  it("UserHub broadcast() reports zero sockets when nobody is connected", async () => {
    const stub = env.USER_HUB.get(env.USER_HUB.idFromName("usr_test"));
    expect(await stub.broadcast("notification", { text: "hi" })).toBe(0);
  });
});
