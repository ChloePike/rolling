import { describe, expect, it } from 'vitest';
import { Handle, isPublicRating, isReservedHandle, normalizeHandle, ProfilePatch } from './profile';

describe('profile rules', () => {
  it('normalises and validates handles', () => {
    expect(normalizeHandle(' @Ada.Lovelace ')).toBe('ada.lovelace');
    expect(Handle.parse('Ada_01')).toBe('ada_01');
    for (const bad of ['ab', 'a'.repeat(31), 'ada-l', 'ada l', 'ádá', '']) expect(Handle.safeParse(bad).success, bad).toBe(false);
    expect(Handle.safeParse('a'.repeat(30)).success).toBe(true);
  });

  it('reserves app words case-insensitively', () => {
    expect(isReservedHandle('Admin')).toBe(true);
    expect(isReservedHandle('@settings')).toBe(true);
    expect(isReservedHandle('ada')).toBe(false);
  });

  it('parses profile patches', () => {
    expect(ProfilePatch.parse({ bio: '  ' })).toEqual({ bio: null });
    expect(ProfilePatch.parse({ name: ' Ada ', handle: 'ADA' })).toEqual({ name: 'Ada', handle: 'ada' });
    expect(ProfilePatch.safeParse({}).success).toBe(false);
    expect(ProfilePatch.safeParse({ bio: 'x'.repeat(161) }).success).toBe(false);
    expect(ProfilePatch.safeParse({ email: 'a@b.c' }).success).toBe(false);
  });

  it('only safe, non-mature media is public (D-005)', () => {
    expect(isPublicRating('safe', 0)).toBe(true);
    expect(isPublicRating('safe', 1)).toBe(false);
    expect(isPublicRating('suggestive', 0)).toBe(false);
    expect(isPublicRating(null, 0)).toBe(false);
  });
});
