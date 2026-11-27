/**
 * Legal document ids and their canonical paths. Kept apart from `docs.ts` (which
 * bundles the documents' text) so redirects and links do not pull the text into
 * the main chunk.
 */
export type LegalDocId = 'terms' | 'privacy' | 'acceptable-use' | 'subprocessors';

export const LEGAL_DOC_IDS: readonly LegalDocId[] = ['terms', 'privacy', 'acceptable-use', 'subprocessors'];

export function isLegalDocId(v: string): v is LegalDocId {
  return (LEGAL_DOC_IDS as readonly string[]).includes(v);
}
