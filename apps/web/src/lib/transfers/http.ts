/**
 * The engine's only network surface. `request` is plain fetch; `put` sends one
 * upload part with byte-level progress (XMLHttpRequest where available, since
 * fetch has no upload progress). The dev mock and the unit tests swap both.
 */
export interface PutOptions {
  signal: AbortSignal;
  onProgress?: (loaded: number) => void;
  headers?: Record<string, string>;
  /** Presigned R2 URLs: 'omit' (no cookies). Worker-proxied parts: 'include'. */
  credentials: 'omit' | 'include';
}

export interface PutResult {
  /** 0 for a network error. */
  status: number;
  header(name: string): string | null;
  text: string;
}

export interface Http {
  request(url: string, init?: RequestInit): Promise<Response>;
  put(url: string, body: Blob, opts: PutOptions): Promise<PutResult>;
}

export class AbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

function xhrPut(url: string, body: Blob, opts: PutOptions): Promise<PutResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.withCredentials = opts.credentials === 'include';
    for (const [k, v] of Object.entries(opts.headers ?? {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => opts.onProgress?.(e.loaded);
    xhr.onload = () => resolve({ status: xhr.status, header: (n) => xhr.getResponseHeader(n), text: xhr.responseText });
    xhr.onerror = () => resolve({ status: 0, header: () => null, text: '' });
    xhr.ontimeout = () => resolve({ status: 0, header: () => null, text: '' });
    xhr.onabort = () => reject(new AbortError());
    if (opts.signal.aborted) return reject(new AbortError());
    opts.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

async function fetchPut(url: string, body: Blob, opts: PutOptions): Promise<PutResult> {
  try {
    const res = await fetch(url, { method: 'PUT', body, headers: opts.headers, credentials: opts.credentials, signal: opts.signal });
    const text = await res.text();
    opts.onProgress?.(body.size);
    return { status: res.status, header: (n) => res.headers.get(n), text };
  } catch (err) {
    if (opts.signal.aborted) throw new AbortError();
    void err;
    return { status: 0, header: () => null, text: '' };
  }
}

export const browserHttp: Http = {
  request: (url, init) => fetch(url, init),
  put: (url, body, opts) => (typeof XMLHttpRequest !== 'undefined' ? xhrPut(url, body, opts) : fetchPut(url, body, opts)),
};
