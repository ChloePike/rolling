/**
 * Device id for the trial's one-per-device check (D-022). Soft by design: a
 * random id kept in a first-party cookie (sent with sign-in requests) and
 * mirrored in localStorage, so clearing one restores it from the other. It
 * identifies a browser, not a person, and is never used for anything else.
 */
const STORAGE_KEY = 'rolling.deviceId';
const COOKIE = 'rolling_did';
const PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const TWO_YEARS_S = 2 * 365 * 86_400;

function readCookie(): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) {
      const v = decodeURIComponent(rest.join('='));
      return PATTERN.test(v) ? v : null;
    }
  }
  return null;
}

function readStorage(): string | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v && PATTERN.test(v) ? v : null;
  } catch {
    return null;
  }
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The device id, created on first use and kept in both places. Safe to call often. */
export function ensureDeviceId(): string | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  const id = readCookie() ?? readStorage() ?? randomId();
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* Storage unavailable: the cookie alone carries it. */
  }
  if (readCookie() !== id) {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=${TWO_YEARS_S}; SameSite=Lax${secure}`;
  }
  return id;
}
