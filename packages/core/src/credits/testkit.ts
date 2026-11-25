/** Test helpers for the credit ledger (not exported from the package barrel). */
import { CreditLedger } from './ledger';
import { MemoryLedgerStore } from './memory';

export function makeLedger(start = Date.UTC(2026, 10, 1)) {
  const clock = { now: start };
  let seq = 0;
  const store = new MemoryLedgerStore();
  const ledger = new CreditLedger(store, {
    now: () => clock.now,
    newId: (kind) => `${kind === 'quote' ? 'qt' : kind === 'job' ? 'job' : 'led'}_${String(++seq).padStart(8, '0')}`,
  });
  return { ledger, store, clock };
}
