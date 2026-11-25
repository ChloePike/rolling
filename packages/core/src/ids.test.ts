import { describe, expect, it } from 'vitest';
import { idTimestamp, isId, newId, parseId } from './ids';

describe('prefixed ULIDs', () => {
  it('creates ids with the right prefix', () => {
    expect(newId('project')).toMatch(/^prj_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newId('node')).toMatch(/^node_/);
    expect(newId('run')).toMatch(/^run_/);
    expect(newId('job')).toMatch(/^job_/);
    expect(newId('asset')).toMatch(/^ast_/);
    expect(newId('ledger')).toMatch(/^led_/);
  });

  it('sorts by creation order', () => {
    const ids = Array.from({ length: 50 }, () => newId('job'));
    expect([...ids].sort()).toEqual(ids);
  });

  it('validates and parses', () => {
    const id = newId('asset');
    expect(isId('asset', id)).toBe(true);
    expect(isId('project', id)).toBe(false);
    expect(isId('asset', 'ast_123')).toBe(false);
    expect(parseId(id)).toMatchObject({ kind: 'asset', prefix: 'ast' });
    expect(parseId('nope_01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeNull();
    const ts = idTimestamp(id)!;
    expect(Math.abs(ts - Date.now())).toBeLessThan(5000);
  });
});
