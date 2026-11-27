/**
 * Trial anti-abuse helpers (D-022), pure. The API stores only SHA-256 hashes
 * of what these return (normalized email, Google subject, IP, subnet, device id).
 */

/**
 * Built-in list of disposable / throwaway email domains. Small on purpose: it
 * catches the common services; subdomains of a listed domain match too.
 */
export const DISPOSABLE_EMAIL_DOMAINS: readonly string[] = [
  '10minutemail.com',
  '20minutemail.com',
  'discard.email',
  'dispostable.com',
  'emailondeck.com',
  'fakeinbox.com',
  'getairmail.com',
  'getnada.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'guerrillamailblock.com',
  'inboxkitten.com',
  'maildrop.cc',
  'mailinator.com',
  'mailnesia.com',
  'mintemail.com',
  'mohmal.com',
  'mytemp.email',
  'sharklasers.com',
  'spamgourmet.com',
  'temp-mail.org',
  'tempmail.com',
  'tempmail.dev',
  'tempmailo.com',
  'tempr.email',
  'throwawaymail.com',
  'trashmail.com',
  'yopmail.com',
  'yopmail.net',
  'mail.tm',
  'moakt.com',
  'burnermail.io',
];

const DISPOSABLE = new Set(DISPOSABLE_EMAIL_DOMAINS);

function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).trim().toLowerCase().replace(/\.+$/, '');
}

/** The email's domain (or a parent domain) is on the disposable list. */
export function isDisposableEmail(email: string): boolean {
  const parts = domainOf(email).split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    if (DISPOSABLE.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

/**
 * The mailbox an address delivers to, so aliases count as one person: lower
 * case, `+tag` dropped everywhere, dots dropped for Gmail, and `googlemail.com`
 * folded into `gmail.com`. Returns null for something that is not an address.
 */
export function normalizeEmail(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  let local = trimmed.slice(0, at);
  let domain = domainOf(trimmed);
  if (!domain.includes('.')) return null;
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  if (!local) return null;
  return `${local}@${domain}`;
}

/**
 * The network an IP belongs to for the per-subnet limit: IPv4 /24
 * (`203.0.113.0/24`), IPv6 /64. Null for anything unparseable.
 */
export function ipSubnet(ip: string): string | null {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (v4) {
    const o = v4.slice(1, 5).map(Number);
    if (o.some((n) => n > 255)) return null;
    return `${o[0]}.${o[1]}.${o[2]}.0/24`;
  }
  const v6 = expandIpv6(ip.trim());
  return v6 ? `${v6.slice(0, 4).join(':')}::/64` : null;
}

/** Eight 16-bit groups (lower-case hex, no leading zeros) or null. */
function expandIpv6(ip: string): string[] | null {
  if (!ip.includes(':') || !/^[0-9a-fA-F:.]+$/.test(ip)) return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  // An embedded IPv4 tail (::ffff:1.2.3.4) counts as two groups.
  const last = tail.length ? tail[tail.length - 1]! : head[head.length - 1] ?? '';
  if (last.includes('.')) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16).toString(16));
}

/** Device id format the client stores (cookie + localStorage): 16–64 URL-safe characters. */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** Cookie the client sets with its device id (soft signal; also kept in localStorage). */
export const DEVICE_COOKIE = 'rolling_did';

/** A device id from a Cookie header, or null. */
export function deviceIdFromCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === DEVICE_COOKIE) {
      const v = decodeURIComponent(rest.join('='));
      return DEVICE_ID_PATTERN.test(v) ? v : null;
    }
  }
  return null;
}

/** Why a sign-up gets no trial (stored with the claim; never shown verbatim). */
export type TrialDenial = 'unverified' | 'disposable' | 'email_used' | 'google_used' | 'device_used' | 'ip_limit' | 'subnet_limit' | 'invalid_email';

export interface TrialSignals {
  emailVerified: boolean;
  email: string | null;
}

/** Checks that need no stored data: verified, a real address, not disposable. */
export function precheckTrial(s: TrialSignals): TrialDenial | null {
  if (!s.emailVerified) return 'unverified';
  if (!s.email || normalizeEmail(s.email) === null) return 'invalid_email';
  if (isDisposableEmail(s.email)) return 'disposable';
  return null;
}
