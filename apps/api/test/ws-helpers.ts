/** Test helpers for refused WebSocket upgrades (accepted, one `error`, closed 4401/4403/4404). */
import { expect } from "vitest";

export async function refusedSocket(res: Response): Promise<{ closeCode: number; error: { code: string; message: string } }> {
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const messages: any[] = [];
  const closed = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve((e as CloseEvent).code)));
  ws.addEventListener("message", (e) => messages.push(JSON.parse(e.data as string)));
  ws.accept();
  const closeCode = await Promise.race([closed, new Promise<number>((_, reject) => setTimeout(() => reject(new Error("socket did not close")), 3000))]);
  expect(messages[0]?.type).toBe("error");
  return { closeCode, error: messages[0].payload };
}
