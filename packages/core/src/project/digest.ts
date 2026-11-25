/**
 * Input digests for node versions and staleness ("Input changed").
 *
 * A node's input digest covers everything that decides its output: its kind,
 * its params and, for every input edge (port order), the upstream node's
 * active version and upstream digest. A version records the digest it was
 * made with; when the node's current digest differs, the version is stale.
 * Changes cascade downstream because each digest includes its upstream digests.
 *
 * The hash is a fast non-cryptographic 64-bit hash (two FNV-1a lanes): digests
 * are compared for equality, never trusted as security tokens.
 */
import type { GraphState, NodeStatus } from '../graph/types';

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function hash64(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h1 >>> 15);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * Current input digest of every node. `activeVersions` maps node id to its
 * active version id (nodes without versions are absent).
 */
export function computeInputDigests(state: GraphState, activeVersions: ReadonlyMap<string, string>): Map<string, string> {
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, { port: string; from: string; i: number }[]>();
  state.edges.forEach((e, i) => {
    const list = incoming.get(e.to.node) ?? [];
    list.push({ port: e.to.port, from: e.from.node, i });
    incoming.set(e.to.node, list);
  });
  const memo = new Map<string, string>();
  const visiting = new Set<string>();

  const digest = (id: string): string => {
    const hit = memo.get(id);
    if (hit) return hit;
    const node = byId.get(id);
    if (!node) return 'missing';
    // Graphs are acyclic (validateConnection); guard anyway.
    if (visiting.has(id)) return 'cycle';
    visiting.add(id);
    const inputs = (incoming.get(id) ?? [])
      .slice()
      .sort((a, b) => (a.port === b.port ? a.i - b.i : a.port < b.port ? -1 : 1))
      .map((e) => [e.port, activeVersions.get(e.from) ?? null, digest(e.from), (byId.get(e.from) as { bypass?: boolean } | undefined)?.bypass ? 1 : 0]);
    visiting.delete(id);
    const d = `dg_${hash64(stableStringify({ k: node.kind, p: node.params, in: inputs }))}`;
    memo.set(id, d);
    return d;
  };

  for (const n of state.nodes) digest(n.id);
  return memo;
}

/**
 * Status a node should show given its version state. Runtime states
 * (queued, generating, failed) are kept; only idle/done/outdated are derived.
 */
export function derivedStatus(current: NodeStatus, activeDigest: string | null, digest: string): NodeStatus {
  if (current === 'queued' || current === 'generating' || current === 'failed') return current;
  if (activeDigest === null) return current === 'done' || current === 'outdated' ? 'idle' : current;
  return activeDigest === digest ? 'done' : 'outdated';
}
