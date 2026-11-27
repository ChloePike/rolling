import { describe, expect, it } from 'vitest';
import { deviceIdFromCookie, ipSubnet, isDisposableEmail, normalizeEmail, precheckTrial } from './trial';

describe('trial anti-abuse helpers (D-022)', () => {
  it('normalizes aliases to one mailbox', () => {
    expect(normalizeEmail('Ada.Lovelace+promo@GMail.com')).toBe('adalovelace@gmail.com');
    expect(normalizeEmail('ada.lovelace@googlemail.com')).toBe('adalovelace@gmail.com');
    expect(normalizeEmail('ada.l+x@example.com')).toBe('ada.l@example.com');
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('+tag@example.com')).toBeNull();
    expect(normalizeEmail('a@localhost')).toBeNull();
  });

  it('flags disposable domains and their subdomains', () => {
    expect(isDisposableEmail('x@mailinator.com')).toBe(true);
    expect(isDisposableEmail('x@eu.mailinator.com')).toBe(true);
    expect(isDisposableEmail('x@YOPMAIL.com')).toBe(true);
    expect(isDisposableEmail('x@gmail.com')).toBe(false);
    expect(isDisposableEmail('x@notmailinator.com')).toBe(false);
  });

  it('groups IPs by /24 (IPv4) and /64 (IPv6)', () => {
    expect(ipSubnet('203.0.113.77')).toBe('203.0.113.0/24');
    expect(ipSubnet('203.0.113.300')).toBeNull();
    expect(ipSubnet('2001:db8:abcd:12::1')).toBe('2001:db8:abcd:12::/64');
    expect(ipSubnet('2001:0db8:abcd:0012:0000:0000:0000:0001')).toBe('2001:db8:abcd:12::/64');
    expect(ipSubnet('::1')).toBe('0:0:0:0::/64');
    expect(ipSubnet('nonsense')).toBeNull();
    expect(ipSubnet('1:2:3')).toBeNull();
  });

  it('reads the device id cookie', () => {
    expect(deviceIdFromCookie('a=1; rolling_did=abcdefghijklmnop1234; b=2')).toBe('abcdefghijklmnop1234');
    expect(deviceIdFromCookie('rolling_did=short')).toBeNull();
    expect(deviceIdFromCookie(null)).toBeNull();
  });

  it('prechecks verified, real, non-disposable addresses', () => {
    expect(precheckTrial({ emailVerified: false, email: 'a@example.com' })).toBe('unverified');
    expect(precheckTrial({ emailVerified: true, email: null })).toBe('invalid_email');
    expect(precheckTrial({ emailVerified: true, email: 'a@yopmail.com' })).toBe('disposable');
    expect(precheckTrial({ emailVerified: true, email: 'a@example.com' })).toBeNull();
  });
});
