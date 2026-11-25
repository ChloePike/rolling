import { monotonicFactory } from 'ulid';

/**
 * Prefixed ULIDs. Every domain id is `<prefix>_<ULID>`, e.g. `prj_01JD3Q...`.
 * ULIDs sort by creation time; the monotonic factory keeps ids created in the
 * same millisecond ordered as well.
 */
export const ID_PREFIXES = {
  project: 'prj',
  node: 'node',
  edge: 'edge',
  group: 'grp',
  version: 'ver',
  run: 'run',
  job: 'job',
  quote: 'qt',
  hold: 'hold',
  asset: 'ast',
  ledger: 'led',
  workspace: 'ws',
  proposal: 'prop',
  thread: 'thr',
  message: 'msg',
  character: 'chr',
  voice: 'voc',
  template: 'tpl',
  share: 'shr',
  timeline: 'tl',
  clip: 'clip',
  event: 'evt',
  user: 'usr',
  session: 'ses',
  account: 'acc',
  verification: 'vrf',
  invite: 'inv',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];
export type PrefixedId<K extends IdKind = IdKind> = `${(typeof ID_PREFIXES)[K]}_${string}`;

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const nextUlid = monotonicFactory();

/** Creates a new id for `kind`, e.g. `newId('project')` → `prj_01JD...`. */
export function newId<K extends IdKind>(kind: K): PrefixedId<K> {
  return `${ID_PREFIXES[kind]}_${nextUlid()}` as PrefixedId<K>;
}

/** True when `value` is a well-formed id of `kind`. */
export function isId<K extends IdKind>(kind: K, value: unknown): value is PrefixedId<K> {
  if (typeof value !== 'string') return false;
  const prefix = `${ID_PREFIXES[kind]}_`;
  return value.startsWith(prefix) && ULID_RE.test(value.slice(prefix.length));
}

/** Splits an id into its kind and ULID, or returns null when it is not a known prefixed ULID. */
export function parseId(value: string): { kind: IdKind; prefix: IdPrefix; ulid: string } | null {
  const sep = value.indexOf('_');
  if (sep <= 0) return null;
  const prefix = value.slice(0, sep);
  const ulid = value.slice(sep + 1);
  if (!ULID_RE.test(ulid)) return null;
  for (const [kind, p] of Object.entries(ID_PREFIXES) as [IdKind, IdPrefix][]) {
    if (p === prefix) return { kind, prefix: p, ulid };
  }
  return null;
}

/** Creation time (ms since epoch) encoded in a prefixed ULID. */
export function idTimestamp(value: string): number | null {
  const parsed = parseId(value);
  if (!parsed) return null;
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let ms = 0;
  for (const ch of parsed.ulid.slice(0, 10)) ms = ms * 32 + alphabet.indexOf(ch);
  return ms;
}
