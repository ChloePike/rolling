import { describe, expect, it } from 'vitest';
import { encodeForm, invoiceSubscriptionId, StripeClient, StripeError, subscriptionPeriod } from './stripe';
import { signStripePayload, StripeSignatureError, verifyStripeSignature } from './webhook';
import { parsePlanLookupKey, planLookupKey, publicPlanCatalog, stripePlanPrices } from './plans';

const SECRET = 'whsec_test_secret';
const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'invoice.paid', created: 1, data: { object: {} } });

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof StripeSignatureError ? e.reason : String(e);
  }
}

describe('verifyStripeSignature', () => {
  it('accepts a valid signature, including one of several v1 values', async () => {
    const now = 1_800_000_000;
    const header = await signStripePayload(payload, SECRET, now);
    expect((await verifyStripeSignature(payload, header, SECRET, { nowSec: now })).id).toBe('evt_1');
    const multi = `t=${now},v1=${'0'.repeat(64)},${header.split(',')[1]}`;
    expect(await reason(verifyStripeSignature(payload, multi, SECRET, { nowSec: now }))).toBe('ok');
  });

  it('rejects tampered bodies, wrong secrets, malformed and stale headers', async () => {
    const now = 1_800_000_000;
    const header = await signStripePayload(payload, SECRET, now);
    expect(await reason(verifyStripeSignature(payload + ' ', header, SECRET, { nowSec: now }))).toBe('no_signature_match');
    expect(await reason(verifyStripeSignature(payload, header, 'whsec_other', { nowSec: now }))).toBe('no_signature_match');
    expect(await reason(verifyStripeSignature(payload, null, SECRET))).toBe('missing_header');
    expect(await reason(verifyStripeSignature(payload, 'v1=abc', SECRET))).toBe('malformed_header');
    expect(await reason(verifyStripeSignature(payload, header, SECRET, { nowSec: now + 301 }))).toBe('timestamp_outside_tolerance');
    expect(await reason(verifyStripeSignature(payload, header, SECRET, { nowSec: now + 300 }))).toBe('ok');
  });
});

describe('Stripe client', () => {
  it('encodes nested params the way Stripe expects', () => {
    expect(encodeForm({ a: 1, m: { k: 'v w' }, li: [{ price: 'p', quantity: 1 }], skip: undefined })).toBe(
      'a=1&m%5Bk%5D=v%20w&li%5B0%5D%5Bprice%5D=p&li%5B0%5D%5Bquantity%5D=1',
    );
  });

  it('sends auth, idempotency key and form body; maps errors', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new StripeClient({
      secretKey: 'sk_test_x',
      baseUrl: 'https://stripe.test',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (url.includes('/v1/customers/bad')) return new Response(JSON.stringify({ error: { message: 'No such customer', type: 'invalid_request_error', code: 'resource_missing' } }), { status: 404 });
        return new Response(JSON.stringify({ id: 'cus_1', object: 'customer' }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await client.createCustomer({ metadata: { workspaceId: 'ws_1' } }, 'customer:ws_1');
    const h = new Headers(calls[0]!.init.headers);
    expect(h.get('authorization')).toBe('Bearer sk_test_x');
    expect(h.get('idempotency-key')).toBe('customer:ws_1');
    expect(calls[0]!.init.body).toBe('metadata%5BworkspaceId%5D=ws_1');
    await expect(client.getCustomer('bad')).rejects.toMatchObject({ status: 404, code: 'resource_missing' });
    await expect(client.getCustomer('bad')).rejects.toBeInstanceOf(StripeError);
  });

  it('reads periods and invoice subscriptions across API versions', () => {
    const base = { id: 'sub', object: 'subscription' as const, customer: 'c', status: 'active', cancel_at_period_end: false };
    expect(subscriptionPeriod({ ...base, current_period_start: 1, current_period_end: 2, items: { data: [] } })).toEqual({ start: 1, end: 2 });
    expect(subscriptionPeriod({ ...base, items: { data: [{ id: 'si', price: {} as never, current_period_start: 3, current_period_end: 4 }] } })).toEqual({ start: 3, end: 4 });
    expect(invoiceSubscriptionId({ id: 'in', object: 'invoice', customer: 'c', status: 'paid', subscription: 'sub_old' })).toBe('sub_old');
    expect(invoiceSubscriptionId({ id: 'in', object: 'invoice', customer: 'c', status: 'paid', parent: { subscription_details: { subscription: 'sub_new' } } })).toBe('sub_new');
  });
});

describe('plan catalog', () => {
  it('derives six subscription prices with lookup keys from PLANS', () => {
    const prices = stripePlanPrices();
    expect(prices).toHaveLength(6);
    expect(prices.find((p) => p.lookupKey === 'rolling_plus_year')).toMatchObject({ unitAmount: 14400, productId: 'rolling_plan_plus' });
    expect(parsePlanLookupKey(planLookupKey('pro', 'month'))).toEqual({ planId: 'pro', interval: 'month' });
    expect(parsePlanLookupKey('other')).toBeNull();
    expect(publicPlanCatalog().topUp).toMatchObject({ minCents: 1000, maxCents: 1_000_000 });
  });
});
