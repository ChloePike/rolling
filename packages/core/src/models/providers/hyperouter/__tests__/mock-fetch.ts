import { HyperouterClient } from '../client';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: RequestRedirect | undefined;
}

type Responder = Response | ((call: RecordedCall) => Response);

/** A fetch double that answers queued responses in order and records every call. */
export function mockFetch(responses: Responder[]) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      redirect: init?.redirect,
    };
    calls.push(call);
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    return typeof next === 'function' ? next(call) : next;
  };
  const client = new HyperouterClient({ apiKey: 'sk-hr-v1-test', fetch: fetchImpl as typeof fetch, now: () => 1_760_000_000_000 });
  return { calls, client, fetchImpl, remaining: () => queue.length };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function errorJson(
  status: number,
  error: { code: string; type?: string; message?: string; param?: string | null; generation_id?: string },
  headers: Record<string, string> = {},
): Response {
  return json({ error: { type: 'error', message: error.code, param: null, ...error } }, status, headers);
}

export function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

/** A byte stream that emits the given string chunks (to split SSE lines anywhere). */
export function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}
