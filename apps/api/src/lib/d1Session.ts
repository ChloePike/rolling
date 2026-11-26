/**
 * D1 read replication through the Sessions API, one session per `/api` request.
 *
 * Both `rolling-*` databases run with `read_replication.mode = "auto"`: reads in a session may be
 * served by a replica near the colo (APAC, WEUR, ...), writes always go to the primary (ENAM).
 *
 * - The middleware opens `env.DB.withSession(start)` per request. `start` is the client's bookmark
 *   (`x-d1-bookmark` header, else the `rolling.d1b` cookie), otherwise `first-unconstrained` for
 *   reads (GET/HEAD/OPTIONS, read-only GraphQL) and `first-primary` for mutations.
 * - Handlers keep writing `c.env.DB`: the middleware swaps `c.env` for a copy whose `DB` routes
 *   `prepare` / `batch` to the request's session (AsyncLocalStorage), so every route, Better Auth
 *   and GraphQL resolver use it without threading a session object through.
 * - The response carries the session's newest bookmark in `x-d1-bookmark` (and, after a mutation,
 *   the cookie). The web client sends the newest one it has seen back: read-your-writes and
 *   monotonic reads across requests, even when a later read lands on a replica.
 * - Workflows, queue consumers, crons and Durable Objects run outside a request and get the raw
 *   binding, which without a session always reads and writes the primary (= `first-primary`).
 *   Credits never touch D1 (CreditAccount DO).
 *
 * The same layer records D1 time per request for `Server-Timing` (`d1;dur=..;desc="n=.. region"`).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

export const BOOKMARK_HEADER = "x-d1-bookmark";
export const BOOKMARK_COOKIE = "rolling.d1b";
/** The cookie only needs to outlive replica lag; a day covers a closed tab coming back. */
const COOKIE_MAX_AGE = 86_400;
/** D1 bookmarks are hex groups joined by dashes; anything else is ignored (never passed to D1). */
const BOOKMARK_RE = /^[0-9a-f]{1,32}(-[0-9a-f]{1,64}){1,7}$/i;

export type SessionStart = D1SessionConstraint | D1SessionBookmark;

/** Per-request state: the session and D1 timing for Server-Timing. */
export interface D1RequestState {
  session: D1DatabaseSession;
  start: SessionStart;
  /** Sum of D1 call durations (ms); parallel calls overlap, so this can exceed wall time. */
  ms: number;
  count: number;
  /** `served_by_region` of the latest result that reported it, plus whether it was the primary. */
  region: string | null;
  primary: boolean | null;
}

const als = new AsyncLocalStorage<D1RequestState>();
const RAW = Symbol("rolling.d1.raw");

/** The current request's D1 state, if any (tests, Server-Timing). */
export function currentD1(): D1RequestState | undefined {
  return als.getStore();
}

export function validBookmark(raw: string | null | undefined): string | null {
  return raw && raw.length <= 256 && BOOKMARK_RE.test(raw) ? raw : null;
}

/** Bookmarks sort lexicographically oldest → newest (D1 Time Travel docs). */
export function newerBookmark(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return b > a ? b : a;
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Reads (and read-only GraphQL) may start on a replica; everything else starts on the primary. */
export function isReadRequest(req: Request): boolean {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return true;
  // GraphQL is read-only (D-003), POST included.
  return req.method === "POST" && new URL(req.url).pathname === "/api/graphql";
}

/** Where a request's session starts: the client's newest bookmark, else by method. */
export function sessionStart(req: Request): SessionStart {
  const header = validBookmark(req.headers.get(BOOKMARK_HEADER));
  const cookie = validBookmark(cookieValue(req.headers.get("cookie"), BOOKMARK_COOKIE));
  const bookmark = newerBookmark(header, cookie);
  if (bookmark) return bookmark;
  return isReadRequest(req) ? "first-unconstrained" : "first-primary";
}

function record(state: D1RequestState | undefined, t0: number, results: unknown): void {
  if (!state) return;
  state.ms += Date.now() - t0;
  state.count += 1;
  const list = Array.isArray(results) ? results : [results];
  for (const r of list) {
    const meta = (r as { meta?: { served_by_region?: string; served_by_primary?: boolean } } | null)?.meta;
    if (meta?.served_by_region) state.region = meta.served_by_region;
    if (typeof meta?.served_by_primary === "boolean") state.primary = meta.served_by_primary;
  }
}

type StatementMethod = "first" | "all" | "run" | "raw";

/** Adds timing to a statement in place (it stays a real D1PreparedStatement, so `batch` accepts it). */
function instrument(stmt: D1PreparedStatement, state: D1RequestState | undefined): D1PreparedStatement {
  if (!state) return stmt;
  try {
    const s = stmt as unknown as Record<string, (...args: unknown[]) => unknown>;
    const bind = s.bind!.bind(stmt);
    s.bind = (...args: unknown[]) => instrument(bind(...args) as D1PreparedStatement, state);
    for (const m of ["first", "all", "run", "raw"] satisfies StatementMethod[]) {
      const fn = s[m]!.bind(stmt);
      s[m] = async (...args: unknown[]) => {
        const t0 = Date.now();
        const out = await fn(...args);
        record(state, t0, m === "all" || m === "run" ? out : null);
        return out;
      };
    }
  } catch {
    // A frozen statement just goes untimed.
  }
  return stmt;
}

/**
 * A D1Database whose queries run in the current request's session (AsyncLocalStorage), or on the
 * raw binding (primary) outside a request. `exec` / `dump` / `withSession` go to the raw binding.
 */
export function routedDatabase(raw: D1Database): D1Database {
  const target = () => als.getStore()?.session ?? raw;
  const db = {
    prepare(query: string): D1PreparedStatement {
      return instrument(target().prepare(query), als.getStore());
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const state = als.getStore();
      const t0 = Date.now();
      const out = await target().batch<T>(statements);
      record(state, t0, out);
      return out;
    },
    exec(query: string) {
      return raw.exec(query);
    },
    dump() {
      return (raw as unknown as { dump(): Promise<ArrayBuffer> }).dump();
    },
    withSession(start?: SessionStart) {
      return raw.withSession(start);
    },
  };
  (db as unknown as Record<symbol, D1Database>)[RAW] = raw;
  return db as unknown as D1Database;
}

const routedEnvs = new WeakMap<object, Env>();

/**
 * One stable copy of `env` per isolate whose `DB` is routed (Better Auth caches its instance per
 * env object, so the copy must not change between requests).
 */
export function routedEnv(env: Env): Env {
  if ((env.DB as unknown as Record<symbol, unknown>)[RAW]) return env;
  let copy = routedEnvs.get(env);
  if (!copy) {
    copy = { ...env, DB: routedDatabase(env.DB) } as Env;
    routedEnvs.set(env, copy);
  }
  return copy;
}

/** Runs `fn` inside a D1 session (tests; the middleware uses the same path). */
export function runInSession<T>(raw: D1Database, start: SessionStart, fn: () => T): { state: D1RequestState; result: T } {
  const state: D1RequestState = { session: raw.withSession(start), start, ms: 0, count: 0, region: null, primary: null };
  return { state, result: als.run(state, fn) };
}

function setHeader(res: Response, name: string, value: string, append = false): Response {
  try {
    if (append) res.headers.append(name, value);
    else res.headers.set(name, value);
    return res;
  } catch {
    // Immutable headers (a Response from fetch / a DO): copy once.
    const copy = new Response(res.body, res);
    if (append) copy.headers.append(name, value);
    else copy.headers.set(name, value);
    return copy;
  }
}

/** `Server-Timing` entry for the request's D1 use (empty when no query ran). */
export function d1ServerTiming(state: D1RequestState): string | null {
  if (state.count === 0) return null;
  const where = state.region ? ` ${state.region}${state.primary ? " primary" : state.primary === false ? " replica" : ""}` : "";
  return `d1;dur=${state.ms};desc="n=${state.count}${where}"`;
}

/**
 * Mounted on `/api/*` before auth. Opens the session, routes `c.env.DB` through it, and returns the
 * newest bookmark plus `Server-Timing: d1, total`.
 */
export const d1SessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const t0 = Date.now();
  const raw = c.env.DB;
  const start = sessionStart(c.req.raw);
  let session: D1DatabaseSession;
  try {
    session = raw.withSession(start);
  } catch {
    // An unusable bookmark (e.g. older than D1 keeps) must not fail the request.
    session = raw.withSession(isReadRequest(c.req.raw) ? "first-unconstrained" : "first-primary");
  }
  const state: D1RequestState = { session, start, ms: 0, count: 0, region: null, primary: null };
  c.env = routedEnv(c.env);
  await als.run(state, () => next());

  if (c.res.status === 101 || c.res.webSocket) return;
  let res = c.res;
  const bookmark = session.getBookmark();
  if (bookmark) {
    res = setHeader(res, BOOKMARK_HEADER, bookmark);
    // Mutations also leave the bookmark in a cookie for requests the API client does not make
    // (Google's form post, a new tab, `<a download>`), so they too read their own writes.
    if (!isReadRequest(c.req.raw)) {
      const secure = new URL(c.req.url).protocol === "https:" ? "; Secure" : "";
      res = setHeader(res, "set-cookie", `${BOOKMARK_COOKIE}=${encodeURIComponent(bookmark)}; Path=/api; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`, true);
    }
  }
  const timing = [d1ServerTiming(state), `total;dur=${Date.now() - t0}`].filter(Boolean).join(", ");
  res = setHeader(res, "server-timing", timing, true);
  c.res = res;
};
