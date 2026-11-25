/**
 * Creates the Stripe catalog for the plans in `packages/core/src/pricing/config.ts`
 * (D-006), idempotently: one product per plan (custom id `rolling_plan_<plan>`)
 * and one recurring USD price per plan × interval, found by lookup key
 * (`rolling_<plan>_<month|year>`). When a configured price changes, a new price
 * takes over the lookup key (`transfer_lookup_key`) and the old one is archived;
 * existing subscriptions keep their old price until changed.
 *
 *   STRIPE_SECRET_KEY=sk_test_… pnpm --filter @rolling/api stripe:sync [--dry-run]
 *
 * Top-ups need no catalog: Checkout uses `price_data` for the chosen amount.
 */
import { StripeClient, StripeError, stripePlanPrices } from "@rolling/core/billing";
import { PLANS, type PlanId } from "@rolling/core/pricing/config";

const dryRun = process.argv.includes("--dry-run");
const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("STRIPE_SECRET_KEY is required.");
  process.exit(1);
}
const appName = process.env.APP_NAME ?? "Rolling";
const stripe = new StripeClient({ secretKey: key, apiVersion: process.env.STRIPE_API_VERSION || undefined, baseUrl: process.env.STRIPE_API_BASE || undefined });

async function ensureProduct(plan: PlanId, productId: string): Promise<void> {
  const name = `${appName} ${PLANS[plan].label}`;
  try {
    const p = await stripe.getProduct(productId);
    if (p.name !== name || p.metadata?.plan !== plan || !p.active) {
      console.log(`update product ${productId}`);
      if (!dryRun) await stripe.updateProduct(productId, { name, active: true, metadata: { plan } });
    } else console.log(`ok     product ${productId}`);
  } catch (e) {
    if (!(e instanceof StripeError) || e.status !== 404) throw e;
    console.log(`create product ${productId}`);
    if (!dryRun) await stripe.createProduct({ id: productId, name, metadata: { plan } }, `product:${productId}`);
  }
}

async function main() {
  const prices = stripePlanPrices();
  for (const plan of new Set(prices.map((p) => p.planId))) await ensureProduct(plan, prices.find((p) => p.planId === plan)!.productId);
  for (const want of prices) {
    const existing = (await stripe.listPricesByLookupKeys([want.lookupKey])).data.find((p) => p.lookup_key === want.lookupKey);
    const productOf = existing ? (typeof existing.product === "string" ? existing.product : existing.product.id) : null;
    const matches =
      existing &&
      existing.active &&
      existing.unit_amount === want.unitAmount &&
      existing.currency === want.currency &&
      existing.recurring?.interval === want.interval &&
      existing.recurring.interval_count === 1 &&
      productOf === want.productId;
    if (matches) {
      console.log(`ok     price ${want.lookupKey} ${existing.id} (${want.unitAmount} ${want.currency})`);
      continue;
    }
    console.log(`create price ${want.lookupKey} (${want.unitAmount} ${want.currency}/${want.interval})${existing ? `, archive ${existing.id}` : ""}`);
    if (dryRun) continue;
    await stripe.createPrice(
      {
        product: want.productId,
        currency: want.currency,
        unit_amount: want.unitAmount,
        recurring: { interval: want.interval },
        lookup_key: want.lookupKey,
        transfer_lookup_key: true,
        metadata: { plan: want.planId, interval: want.interval },
      },
      `price:${want.lookupKey}:${want.unitAmount}:${want.currency}`,
    );
    if (existing) await stripe.request("POST", `/v1/prices/${existing.id}`, { active: false });
  }
  console.log(dryRun ? "Dry run: nothing changed." : "Stripe catalog is in sync.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
