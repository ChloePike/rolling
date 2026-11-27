/**
 * The legal documents (`legal/*.md` at the repo root), bundled at build time
 * as raw text and parsed once per document. Canonical public paths are
 * registered with Google OAuth: `/terms` and `/privacy` must not move.
 */
import aup from '@legal/acceptable-use-policy.md?raw';
import privacy from '@legal/privacy-policy.md?raw';
import subprocessors from '@legal/subprocessors.md?raw';
import terms from '@legal/terms-of-service.md?raw';
import { parseMarkdown, type Block } from './markdown';

import type { LegalDocId } from './ids';

export { isLegalDocId, type LegalDocId } from './ids';

export interface LegalDocInfo {
  id: LegalDocId;
  path: `/${LegalDocId}`;
  source: string;
}

export const LEGAL_DOCS: readonly LegalDocInfo[] = [
  { id: 'terms', path: '/terms', source: terms },
  { id: 'privacy', path: '/privacy', source: privacy },
  { id: 'acceptable-use', path: '/acceptable-use', source: aup },
  { id: 'subprocessors', path: '/subprocessors', source: subprocessors },
];

const parsed = new Map<LegalDocId, Block[]>();

export function legalBlocks(id: LegalDocId): Block[] {
  let blocks = parsed.get(id);
  if (!blocks) {
    blocks = parseMarkdown(LEGAL_DOCS.find((d) => d.id === id)!.source);
    parsed.set(id, blocks);
  }
  return blocks;
}
