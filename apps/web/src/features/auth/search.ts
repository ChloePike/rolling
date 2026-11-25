/** `/login` and `/signup` search params: where to go after signing in, and an OAuth error code from the callback. */
export interface AuthSearch {
  redirect?: string;
  error?: string;
}

export function authSearch(raw: Record<string, unknown>): AuthSearch {
  const out: AuthSearch = {};
  if (typeof raw.redirect === 'string' && raw.redirect) out.redirect = raw.redirect;
  if (typeof raw.error === 'string' && raw.error) out.error = raw.error.slice(0, 64);
  return out;
}
