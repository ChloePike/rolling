// Shared helpers for the PoseWear import scripts (Node, run with tsx).
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = join(HERE, 'out');
export const SNAPSHOT_PATH = join(OUT_DIR, 'snapshot.json');
export const USER_AGENT = 'rolling-library-import/1.0';

export function ensureOutDir(): void {
  mkdirSync(OUT_DIR, { recursive: true });
}

export function parseArgs(argv: string[]): Map<string, string | true> {
  const args = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) args.set(a.slice(2, eq), a.slice(eq + 1));
    else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) args.set(a.slice(2), argv[++i]!);
    else args.set(a.slice(2), true);
  }
  return args;
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export async function fetchWithRetry(url: string, init: RequestInit = {}, attempts = 4): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'user-agent': USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
      });
      if (res.status < 500 && res.status !== 429) return res;
      lastError = new Error(`HTTP ${res.status} for ${url}`);
      await res.body?.cancel();
    } catch (error) {
      lastError = error;
    }
    await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `worker` over `items` with at most `limit` in flight. */
export async function pool<T>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
}
