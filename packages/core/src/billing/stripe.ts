/**
 * Thin, typed Stripe REST client over `fetch` (runs on Workers, no Node SDK).
 * Only the endpoints Rolling uses. Field types cover what we read and accept
 * both pre- and post-2025 API shapes where Stripe moved fields (invoice
 * subscription, subscription period on items).
 */

export const STRIPE_API_BASE = 'https://api.stripe.com';

export type FormValue = string | number | boolean | null | undefined | FormValue[] | { [k: string]: FormValue };

/** Stripe's bracketed form encoding: `a[b][0][c]=v`. `undefined`/`null` are skipped. */
export function encodeForm(params: Record<string, FormValue>): string {
  const out: string[] = [];
  const walk = (value: FormValue, key: string) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${key}[${i}]`));
    else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, `${key}[${k}]`);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  };
  for (const [k, v] of Object.entries(params)) walk(v, k);
  return out.join('&');
}

export class StripeError extends Error {
  override readonly name = 'StripeError';
  constructor(
    readonly status: number,
    message: string,
    readonly type?: string,
    readonly code?: string,
    readonly declineCode?: string,
  ) {
    super(message);
  }
}

export type Metadata = Record<string, string>;

export interface StripePrice {
  id: string;
  object: 'price';
  active: boolean;
  currency: string;
  unit_amount: number | null;
  lookup_key: string | null;
  product: string | { id: string };
  recurring: { interval: 'day' | 'week' | 'month' | 'year'; interval_count: number } | null;
  metadata?: Metadata;
}

export interface StripeProduct {
  id: string;
  object: 'product';
  name: string;
  active: boolean;
  metadata?: Metadata;
}

export interface StripeCustomer {
  id: string;
  object: 'customer';
  email?: string | null;
  metadata?: Metadata;
  deleted?: boolean;
  invoice_settings?: { default_payment_method: string | { id: string } | null };
}

export interface StripeSubscriptionItem {
  id: string;
  price: StripePrice;
  /** 2025-03-31+ API versions. */
  current_period_start?: number;
  current_period_end?: number;
}

export interface StripeSubscription {
  id: string;
  object: 'subscription';
  customer: string | { id: string };
  status: string;
  cancel_at_period_end: boolean;
  /** Pre-2025-03-31 API versions. */
  current_period_start?: number;
  current_period_end?: number;
  default_payment_method?: string | { id: string } | null;
  items: { data: StripeSubscriptionItem[] };
  metadata?: Metadata;
}

export interface StripeCheckoutSession {
  id: string;
  object: 'checkout.session';
  url: string | null;
  mode: 'payment' | 'subscription' | 'setup';
  status: 'open' | 'complete' | 'expired' | null;
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  customer: string | { id: string } | null;
  subscription: string | { id: string } | null;
  payment_intent: string | { id: string } | null;
  amount_total: number | null;
  currency: string | null;
  metadata: Metadata | null;
  client_reference_id: string | null;
}

export interface StripeInvoice {
  id: string;
  object: 'invoice';
  customer: string | { id: string };
  status: string;
  billing_reason?: string | null;
  amount_paid?: number;
  /** Pre-2025-03-31 API versions. */
  subscription?: string | { id: string } | null;
  /** 2025-03-31+ API versions. */
  parent?: { subscription_details?: { subscription: string | { id: string } | null; metadata?: Metadata | null } | null } | null;
  lines?: { data: { period?: { start: number; end: number } }[] };
}

export interface StripePaymentIntent {
  id: string;
  object: 'payment_intent';
  status: string;
  amount: number;
  currency: string;
  metadata?: Metadata;
  last_payment_error?: { code?: string; decline_code?: string; message?: string } | null;
}

export interface StripePortalSession {
  id: string;
  url: string;
}

export interface StripeList<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
}

export interface StripeEvent<T = unknown> {
  id: string;
  object: 'event';
  type: string;
  created: number;
  livemode: boolean;
  data: { object: T; previous_attributes?: Record<string, unknown> };
}

export interface StripeClientOptions {
  secretKey: string;
  /** Pin an API version (e.g. `2025-09-30.clover`); omitted = the account default. */
  apiVersion?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** id of an expandable field. */
export function idOf(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === 'string' ? v : v.id;
}

export class StripeClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: StripeClientOptions) {
    this.base = (opts.baseUrl ?? STRIPE_API_BASE).replace(/\/$/, '');
    // Resolve lazily so tests can stub the global fetch.
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params?: Record<string, FormValue>, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.opts.secretKey}` };
    if (this.opts.apiVersion) headers['stripe-version'] = this.opts.apiVersion;
    let url = `${this.base}${path}`;
    let body: string | undefined;
    const form = params ? encodeForm(params) : '';
    if (method === 'GET' || method === 'DELETE') {
      if (form) url += `${url.includes('?') ? '&' : '?'}${form}`;
    } else {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = form;
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    }
    const res = await this.doFetch(url, { method, headers, body });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new StripeError(res.status, `Stripe returned non-JSON (${res.status})`);
    }
    if (!res.ok) {
      const err = (json as { error?: { message?: string; type?: string; code?: string; decline_code?: string } }).error ?? {};
      throw new StripeError(res.status, err.message ?? `Stripe error ${res.status}`, err.type, err.code, err.decline_code);
    }
    return json as T;
  }

  createCustomer(params: { email?: string; name?: string; metadata: Metadata }, idempotencyKey: string) {
    return this.request<StripeCustomer>('POST', '/v1/customers', params, idempotencyKey);
  }
  getCustomer(id: string) {
    return this.request<StripeCustomer>('GET', `/v1/customers/${encodeURIComponent(id)}`);
  }
  createCheckoutSession(params: Record<string, FormValue>, idempotencyKey?: string) {
    return this.request<StripeCheckoutSession>('POST', '/v1/checkout/sessions', params, idempotencyKey);
  }
  getCheckoutSession(id: string) {
    return this.request<StripeCheckoutSession>('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`);
  }
  createPortalSession(params: { customer: string; return_url: string }) {
    return this.request<StripePortalSession>('POST', '/v1/billing_portal/sessions', params);
  }
  getSubscription(id: string) {
    return this.request<StripeSubscription>('GET', `/v1/subscriptions/${encodeURIComponent(id)}`);
  }
  listPricesByLookupKeys(keys: readonly string[]) {
    return this.request<StripeList<StripePrice>>('GET', '/v1/prices', { lookup_keys: [...keys], active: true, limit: 100 });
  }
  getProduct(id: string) {
    return this.request<StripeProduct>('GET', `/v1/products/${encodeURIComponent(id)}`);
  }
  createProduct(params: Record<string, FormValue>, idempotencyKey: string) {
    return this.request<StripeProduct>('POST', '/v1/products', params, idempotencyKey);
  }
  updateProduct(id: string, params: Record<string, FormValue>) {
    return this.request<StripeProduct>('POST', `/v1/products/${encodeURIComponent(id)}`, params);
  }
  createPrice(params: Record<string, FormValue>, idempotencyKey: string) {
    return this.request<StripePrice>('POST', '/v1/prices', params, idempotencyKey);
  }
  createPaymentIntent(params: Record<string, FormValue>, idempotencyKey: string) {
    return this.request<StripePaymentIntent>('POST', '/v1/payment_intents', params, idempotencyKey);
  }
}

/** Subscription period (epoch seconds) across API versions. */
export function subscriptionPeriod(sub: StripeSubscription): { start: number; end: number } | null {
  const item = sub.items?.data?.[0];
  const start = item?.current_period_start ?? sub.current_period_start;
  const end = item?.current_period_end ?? sub.current_period_end;
  return typeof start === 'number' && typeof end === 'number' ? { start, end } : null;
}

/** Subscription id of an invoice across API versions. */
export function invoiceSubscriptionId(inv: StripeInvoice): string | null {
  return idOf(inv.parent?.subscription_details?.subscription ?? null) ?? idOf(inv.subscription ?? null);
}
