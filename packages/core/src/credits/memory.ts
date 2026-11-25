/** In-memory `LedgerStore` for tests and tools. Transactions roll back on throw. */
import { emptyAccount, type LedgerStore } from './ledger';
import type { AccountState, HoldRecord, IdemRecord, LedgerLine, StoredQuote } from './types';

interface Data {
  account: AccountState;
  quotes: Map<string, StoredQuote>;
  holds: Map<string, HoldRecord>;
  usage: Map<string, number>;
  idem: Map<string, IdemRecord>;
  lines: LedgerLine[];
}

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryLedgerStore implements LedgerStore {
  private data: Data = {
    account: emptyAccount(),
    quotes: new Map(),
    holds: new Map(),
    usage: new Map(),
    idem: new Map(),
    lines: [],
  };

  transaction<T>(fn: () => T): T {
    const snapshot = clone(this.data);
    try {
      return fn();
    } catch (e) {
      this.data = snapshot;
      throw e;
    }
  }

  getAccount(): AccountState {
    return clone(this.data.account);
  }
  putAccount(state: AccountState): void {
    this.data.account = clone(state);
  }
  getQuote(id: string): StoredQuote | null {
    const q = this.data.quotes.get(id);
    return q ? clone(q) : null;
  }
  putQuote(quote: StoredQuote): void {
    this.data.quotes.set(quote.id, clone(quote));
  }
  getHold(jobId: string): HoldRecord | null {
    const h = this.data.holds.get(jobId);
    return h ? clone(h) : null;
  }
  putHold(hold: HoldRecord): void {
    this.data.holds.set(hold.jobId, clone(hold));
  }
  openHolds(): HoldRecord[] {
    return [...this.data.holds.values()].filter((h) => h.status === 'held').map(clone);
  }
  holdsForQuote(quoteId: string): HoldRecord[] {
    return [...this.data.holds.values()].filter((h) => h.quoteId === quoteId).map(clone);
  }
  allHolds(): HoldRecord[] {
    return [...this.data.holds.values()].map(clone);
  }
  getMemberSpent(userId: string, month: string): number {
    return this.data.usage.get(`${userId}|${month}`) ?? 0;
  }
  addMemberSpent(userId: string, month: string, amount: number): void {
    const k = `${userId}|${month}`;
    this.data.usage.set(k, (this.data.usage.get(k) ?? 0) + amount);
  }
  getIdem(key: string): IdemRecord | null {
    const r = this.data.idem.get(key);
    return r ? clone(r) : null;
  }
  putIdem(record: IdemRecord): void {
    this.data.idem.set(record.key, clone(record));
  }
  appendLines(lines: LedgerLine[]): void {
    const keys = new Set(this.data.lines.map((l) => l.idemKey));
    for (const l of lines) {
      if (keys.has(l.idemKey)) throw new Error(`duplicate ledger idem key ${l.idemKey}`);
      keys.add(l.idemKey);
    }
    this.data.lines.push(...clone(lines));
  }
  allLines(): LedgerLine[] {
    return clone(this.data.lines);
  }
}
