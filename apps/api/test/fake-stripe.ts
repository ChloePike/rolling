/**
 * A small in-memory Stripe for tests, served through a stubbed `fetch`
 * (`STRIPE_API_BASE=https://stripe.test`). Records every call; holds
 * customers, checkout sessions and subscriptions; signs webhook events.
 */
import { signStripePayload, stripePlanPrices, stripeSeatPrices, type StripeSubscription } from "@rolling/core/billing";

export const STRIPE_BASE = "https://stripe.test";
export const WEBHOOK_SECRET = "whsec_test_rolling";
export const stripeEnv = { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_API_BASE: STRIPE_BASE };

export interface FakeCall {
  method: string;
  path: string;
  form: Record<string, string>;
  query: Record<string, string>;
  idempotencyKey: string | null;
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(++counter).toString(36)}`;

export class FakeStripe {
  calls: FakeCall[] = [];
  customers = new Map<string, { id: string; default_payment_method: string | null }>();
  sessions = new Map<string, Record<string, unknown>>();
  subscriptions = new Map<string, StripeSubscription>();
  declineNextCharge = false;
  realFetch = globalThis.fetch;

  priceFor(lookupKey: string) {
    const p = [...stripePlanPrices(), ...stripeSeatPrices()].find((x) => x.lookupKey === lookupKey);
    if (!p) return null;
    return {
      id: `price_${lookupKey}`,
      object: "price",
      active: true,
      currency: "usd",
      unit_amount: p.unitAmount,
      lookup_key: lookupKey,
      product: p.productId,
      recurring: { interval: p.interval, interval_count: 1 },
    };
  }

  /** Creates a subscription as Stripe would after a plan checkout (2025+ shape: period on items). */
  addSubscription(opts: { customer: string; lookupKey: string; start: number; end: number; status?: string; workspaceId?: string; id?: string; seatQuantity?: number }): StripeSubscription {
    const period = { current_period_start: Math.floor(opts.start / 1000), current_period_end: Math.floor(opts.end / 1000) };
    const interval = opts.lookupKey.endsWith("_year") ? "year" : "month";
    const sub = {
      id: opts.id ?? nextId("sub"),
      object: "subscription",
      customer: opts.customer,
      status: opts.status ?? "active",
      cancel_at_period_end: false,
      default_payment_method: "pm_card_visa",
      items: {
        data: [
          { id: nextId("si"), price: this.priceFor(opts.lookupKey)!, quantity: 1, ...period },
          ...(opts.seatQuantity ? [{ id: nextId("si"), price: this.priceFor(`rolling_team_seat_${interval}`)!, quantity: opts.seatQuantity, ...period }] : []),
        ],
      },
      metadata: opts.workspaceId ? { workspaceId: opts.workspaceId } : {},
    } as unknown as StripeSubscription;
    this.subscriptions.set(sub.id, sub);
    return sub;
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== STRIPE_BASE) return this.realFetch(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const form = Object.fromEntries(new URLSearchParams(typeof init?.body === "string" ? init.body : ""));
    const query = Object.fromEntries(url.searchParams);
    this.calls.push({ method, path: url.pathname, form, query, idempotencyKey: headers.get("idempotency-key") });
    if (headers.get("authorization") !== `Bearer ${stripeEnv.STRIPE_SECRET_KEY}`) return json({ error: { message: "Invalid API key" } }, 401);
    const p = url.pathname;
    let m: RegExpExecArray | null;

    if (method === "GET" && p === "/v1/prices") {
      const keys = Object.entries(query).filter(([k]) => k.startsWith("lookup_keys")).map(([, v]) => v);
      return json({ object: "list", data: keys.map((k) => this.priceFor(k)).filter(Boolean), has_more: false });
    }
    if (method === "POST" && p === "/v1/customers") {
      const c = { id: nextId("cus"), default_payment_method: null };
      this.customers.set(c.id, c);
      return json({ id: c.id, object: "customer", metadata: { workspaceId: form["metadata[workspaceId]"] } });
    }
    if (method === "GET" && (m = /^\/v1\/customers\/([^/]+)$/.exec(p))) {
      const c = this.customers.get(m[1]!);
      if (!c) return json({ error: { message: "No such customer", code: "resource_missing" } }, 404);
      return json({ id: c.id, object: "customer", invoice_settings: { default_payment_method: c.default_payment_method } });
    }
    if (method === "POST" && p === "/v1/checkout/sessions") {
      const id = nextId("cs_test");
      const session = { id, object: "checkout.session", url: `https://checkout.stripe.test/${id}`, form };
      this.sessions.set(id, session);
      return json(session);
    }
    if (method === "POST" && p === "/v1/billing_portal/sessions") return json({ id: nextId("bps"), url: `https://billing.stripe.test/p/${form.customer}` });
    if (method === "GET" && (m = /^\/v1\/subscriptions\/([^/]+)$/.exec(p))) {
      const s = this.subscriptions.get(m[1]!);
      return s ? json(s) : json({ error: { message: "No such subscription", code: "resource_missing" } }, 404);
    }
    if (method === "POST" && (m = /^\/v1\/subscriptions\/([^/]+)$/.exec(p))) {
      const s = this.subscriptions.get(m[1]!);
      if (!s) return json({ error: { message: "No such subscription", code: "resource_missing" } }, 404);
      // Items: `items[i][id]` (+ price / quantity / deleted) updates, `items[i][price]` alone adds.
      const changes = new Map<number, Record<string, string>>();
      for (const [k, v] of Object.entries(form)) {
        const im = /^items\[(\d+)\]\[(\w+)\]$/.exec(k);
        if (im) changes.set(Number(im[1]), { ...(changes.get(Number(im[1])) ?? {}), [im[2]!]: v });
      }
      const priceById = (id: string) => this.priceFor(id.replace(/^price_/, ""))!;
      if (this.declineNextCharge && form.payment_behavior === "pending_if_incomplete") {
        this.declineNextCharge = false;
        return json({ ...s, pending_update: { subscription_items: [...changes.values()], expires_at: 0 } });
      }
      const first = s.items.data[0]!;
      for (const ch of changes.values()) {
        if (ch.id) {
          const idx = s.items.data.findIndex((i) => i.id === ch.id);
          if (idx < 0) continue;
          if (ch.deleted === "true") s.items.data.splice(idx, 1);
          else s.items.data[idx] = { ...s.items.data[idx]!, ...(ch.price ? { price: priceById(ch.price) } : {}), ...(ch.quantity ? { quantity: Number(ch.quantity) } : {}) } as never;
        } else if (ch.price) {
          s.items.data.push({ id: nextId("si"), price: priceById(ch.price), quantity: Number(ch.quantity ?? 1), current_period_start: first.current_period_start, current_period_end: first.current_period_end } as never);
        }
      }
      s.metadata = { ...(s.metadata ?? {}), ...Object.fromEntries(Object.entries(form).filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])) };
      return json({ ...s, pending_update: null });
    }
    if (method === "POST" && p === "/v1/payment_intents") {
      if (this.declineNextCharge) {
        this.declineNextCharge = false;
        return json({ error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds." } }, 402);
      }
      const metadata = Object.fromEntries(Object.entries(form).filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v]));
      return json({ id: nextId("pi"), object: "payment_intent", status: "succeeded", amount: Number(form.amount), currency: form.currency, metadata });
    }
    if (method === "GET" && p === "/v1/invoices") {
      return json({ object: "list", has_more: false, data: [{ id: "in_1", number: "R-0001", created: 1_800_000_000, amount_paid: 1500, currency: "usd", status: "paid", hosted_invoice_url: "https://invoice.stripe.test/in_1", invoice_pdf: null }] });
    }
    return json({ error: { message: `Fake Stripe has no route ${method} ${p}` } }, 404);
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A signed webhook request for `event`. */
export async function webhookRequest(event: { id?: string; type: string; object: unknown }, opts: { timestampSec?: number; secret?: string } = {}): Promise<Request> {
  const payload = JSON.stringify({ id: event.id ?? nextId("evt"), object: "event", type: event.type, created: Math.floor(Date.now() / 1000), livemode: false, data: { object: event.object } });
  const header = await signStripePayload(payload, opts.secret ?? WEBHOOK_SECRET, opts.timestampSec ?? Math.floor(Date.now() / 1000));
  return new Request("https://example.com/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: payload });
}
