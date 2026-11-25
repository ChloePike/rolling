import { ApiError, errorFromBody } from './errors';

/**
 * Typed fetch client for `/api` (same origin; Vite proxies it in dev).
 *
 * - Cookies always go along (`credentials: 'include'`): the session is the
 *   Better Auth cookie.
 * - The active workspace goes in `x-workspace-id` (WebSocket upgrades use
 *   `?workspaceId=`); without one the server picks the personal workspace.
 * - Failures throw `ApiError` built from the error envelope; network failures
 *   throw `ApiError('NETWORK')`.
 */

const WORKSPACE_KEY = 'rolling.workspace';
const listeners = new Set<(id: string | null) => void>();
let workspaceId: string | null | undefined;

function readStored(): string | null {
  try {
    return window.localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

/** The workspace the client acts on, or null for the server default (personal). */
export function getWorkspaceId(): string | null {
  if (workspaceId === undefined) workspaceId = typeof window === 'undefined' ? null : readStored();
  return workspaceId;
}

/** Switches the workspace for every following request (remembered across reloads). */
export function setWorkspaceId(id: string | null): void {
  if (id === getWorkspaceId()) return;
  workspaceId = id;
  try {
    if (id) window.localStorage.setItem(WORKSPACE_KEY, id);
    else window.localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    /* Storage unavailable: the choice lasts for this page. */
  }
  for (const l of listeners) l(id);
}

export function onWorkspaceChange(cb: (id: string | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** JSON body (serialized here). */
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Send no `x-workspace-id` (auth routes, public reads). */
  noWorkspace?: boolean;
  /** Override the workspace for this request. */
  workspaceId?: string;
}

/** Test seam: replace the transport (unit tests). */
let fetchImpl: typeof fetch | null = null;
export function setFetchForTests(f: typeof fetch | null) {
  fetchImpl = f;
}

export function apiUrl(path: string, query?: RequestOptions['query']): string {
  const p = path.startsWith('/api') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`;
  if (!query) return p;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${p}?${s}` : p;
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const ws = opts.workspaceId ?? (opts.noWorkspace ? null : getWorkspaceId());
  if (ws) headers['x-workspace-id'] = ws;
  let res: Response;
  try {
    res = await (fetchImpl ?? fetch)(apiUrl(path, opts.query), {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'include',
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw e;
    throw new ApiError('NETWORK', e instanceof Error ? e.message : 'Network error', 0);
  }
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) throw errorFromBody(res.status, body);
  return body as T;
}

export const api = {
  get: <T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body'>) => apiRequest<T>(path, { ...opts, method: 'GET' }),
  post: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) => apiRequest<T>(path, { ...opts, method: 'POST', body: body ?? {} }),
  patch: <T>(path: string, body: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) => apiRequest<T>(path, { ...opts, method: 'PATCH', body }),
  delete: <T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body'>) => apiRequest<T>(path, { ...opts, method: 'DELETE' }),
};
