import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface Envelope {
  type: string;
  id: string;
  payload: any;
}

async function connect(projectId: string): Promise<{ ws: WebSocket; next: () => Promise<Envelope> }> {
  const res = await SELF.fetch(`https://example.com/api/projects/${projectId}/ws`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const queue: Envelope[] = [];
  const waiters: ((e: Envelope) => void)[] = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data as string) as Envelope;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  ws.accept();
  const next = () =>
    new Promise<Envelope>((resolve, reject) => {
      const queued = queue.shift();
      if (queued) return resolve(queued);
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), 2000);
      waiters.push((e) => {
        clearTimeout(timer);
        resolve(e);
      });
    });
  return { ws, next };
}

describe("ProjectRoom WebSocket", () => {
  it("sends a snapshot, acks a patch with the next revision and broadcasts it", async () => {
    const a = await connect("prj_test1");
    const snapshot = await a.next();
    expect(snapshot.type).toBe("snapshot");
    expect(snapshot.payload).toMatchObject({ projectId: "prj_test1", revision: 0, nodes: [], edges: [] });

    const b = await connect("prj_test1");
    expect((await b.next()).type).toBe("snapshot");

    a.ws.send(JSON.stringify({ type: "patch", id: "m1", payload: { baseRevision: 0, ops: [{ op: "noop" }] } }));
    expect(await a.next()).toEqual({ type: "ack", id: "m1", payload: { revision: 1 } });

    const broadcast = await b.next();
    expect(broadcast.type).toBe("graph.patched");
    expect(broadcast.payload).toMatchObject({ revision: 1, ops: [{ op: "noop" }] });

    // A stale base revision gets a conflict with the current snapshot.
    b.ws.send(JSON.stringify({ type: "patch", id: "m2", payload: { baseRevision: 0, ops: [] } }));
    const conflict = await b.next();
    expect(conflict).toMatchObject({ type: "conflict", id: "m2", payload: { snapshot: { revision: 1 } } });

    // Invalid envelopes get an error, not a crash.
    a.ws.send("not json");
    expect(await a.next()).toMatchObject({ type: "error", payload: { code: "BAD_MESSAGE" } });

    a.ws.close();
    b.ws.close();
  });

  it("refuses non-upgrade requests with the error envelope", async () => {
    const res = await SELF.fetch("https://example.com/api/projects/prj_x/ws");
    expect(res.status).toBe(426);
    expect(await res.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });
});
