import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.FFMPEG_SERVER_NO_LISTEN = "1";
const { start } = await import("../src/server.ts");

let base = "";
let server: ReturnType<typeof start>;

beforeAll(async () => {
  server = start(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("ffmpeg container server", () => {
  it("answers /health", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it.each(["/render", "/probe", "/thumb", "/waveform"])("stubs %s with 501", async (path) => {
    const res = await fetch(`${base}${path}`, { method: "POST" });
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ error: { code: "NOT_IMPLEMENTED" } });
  });
});
