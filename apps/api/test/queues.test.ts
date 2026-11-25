import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { baseQueueName } from "../src/queues";

describe("queues", () => {
  it("maps environment queue names to base names", () => {
    expect(baseQueueName("rolling-staging-media-process")).toBe("media-process");
    expect(baseQueueName("rolling-dev-ledger-mirror")).toBe("ledger-mirror");
  });

  it("media-process consumer acks valid and malformed messages", async () => {
    const batch = createMessageBatch("rolling-dev-media-process", [
      { id: "m1", timestamp: new Date(), attempts: 1, body: { assetId: "ast_1", r2Key: "k", kind: "video" } },
      { id: "m2", timestamp: new Date(), attempts: 1, body: { nope: true } },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks.sort()).toEqual(["m1", "m2"]);
    expect(result.retryBatch.retry).toBe(false);
  });
});
