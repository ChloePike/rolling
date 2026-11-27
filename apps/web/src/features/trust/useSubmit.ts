import { useState } from 'react';
import { isApiError } from '@/lib/api/errors';

/** Submit state for the trust forms: busy, the case id on success, an error message. */
export function useSubmit<I>(fn: (input: I) => Promise<{ caseId: string }>, fallback: string) {
  const [busy, setBusy] = useState(false);
  const [caseId, setCaseId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = (input: I) => {
    setBusy(true);
    setError(null);
    fn(input)
      .then((r) => setCaseId(r.caseId))
      .catch((e: unknown) => setError(isApiError(e) && e.code !== 'VALIDATION_FAILED' && e.message ? e.message : fallback))
      .finally(() => setBusy(false));
  };
  return { busy, caseId, error, submit };
}
