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

  it.each(["/probe", "/thumb", "/waveform"])("%s validates its input", async (path) => {
    const res = await fetch(`${base}${path}`, { method: "POST", body: JSON.stringify({ url: "file:///etc/passwd" }) });
    expect(res.status).toBe(400);
    expect((await fetch(`${base}${path}`)).status).toBe(405);
  });

  it("computes waveform peaks", async () => {
    const { peaks } = await import("../src/server.ts");
    const pcm = Buffer.alloc(8);
    pcm.writeInt16LE(16384, 0);
    pcm.writeInt16LE(-32768, 6);
    expect(peaks(pcm, 2)).toEqual([0.5, 1]);
  });

  it("validates /render jobs and answers 404 for unknown renders", async () => {
    expect((await fetch(`${base}/render`)).status).toBe(405);
    const bad = await fetch(`${base}/render`, { method: "POST", body: JSON.stringify({ id: "x y" }) });
    expect(bad.status).toBe(400);
    const file = await fetch(`${base}/render`, {
      method: "POST",
      body: JSON.stringify({ id: "exp_1", width: 720, height: 1280, fps: 24, duration: 1, edl: { fps: 24, width: 720, height: 1280, tracks: [] }, inputs: { a: { url: "file:///etc/passwd" } } }),
    });
    expect(file.status).toBe(400);
    expect((await fetch(`${base}/render/exp_none`)).status).toBe(404);
    expect((await fetch(`${base}/render/exp_none/file`)).status).toBe(404);
    expect(await (await fetch(`${base}/render/exp_none`, { method: "DELETE" })).json()).toEqual({ ok: false });
  });
});
