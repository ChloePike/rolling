/**
 * Live smoke test of the generation pipeline logic against Hyperouter (M4).
 * NOT run in CI: it spends real money (one image on the cheapest Auto-eligible
 * image model, about $0.02).
 *
 * Steps (the same core code the GenerateWorkflow uses): sync the live catalog →
 * plan a tool-page prompt spec (Auto, deterministic fallback, no classifier) →
 * price it (creditsFor) → build the provider request → submit with an
 * idempotency key → re-submit with the same key (must return the same job) →
 * poll until done → download the output → convert the provider cost to credits.
 *
 * Run:
 *   HYPEROUTER_API_KEY=sk-hr-v1-... NODE_USE_ENV_PROXY=1 \
 *     packages/core/node_modules/.bin/tsx apps/api/scripts/live-generate.ts
 */
import { Catalog, creditsFor, creditsForUsd, hyperouter, pollUntilDone } from "@rolling/core";
import { buildGenerateRequest, planPromptSpec, requestProblems } from "@rolling/core/generation";
import { newId } from "@rolling/core/ids";

async function main(): Promise<void> {
  const apiKey = process.env.HYPEROUTER_API_KEY;
  if (!apiKey) throw new Error("HYPEROUTER_API_KEY is not set.");
  const client = new hyperouter.HyperouterClient({ apiKey });

  const t0 = Date.now();
  const { data: listing } = await client.json<unknown>(hyperouter.HYPEROUTER_PATHS.models);
  const { catalog } = Catalog.fromListing(listing);
  console.log(`catalog: ${catalog.size} models`);

  // Auto without a classifier = the cheapest capable image model (pickAuto-equivalent, D-009).
  const plan = await planPromptSpec({
    spec: { kind: "image", model: "auto", prompt: "A single green apple on a plain white table, soft daylight, product photo", inputs: {} },
    catalog,
    ctx: { plan: "starter", matureAllowed: false },
    classify: null,
    assetOrigins: new Map(),
  });
  const item = plan.items[0]!;
  if (item.action !== "run" || !item.spec || !item.model) throw new Error(`plan refused: ${item.code} ${item.reason}`);
  const model = catalog.get(item.model)!;
  const quoted = creditsFor(model, item.priceRequest ?? {});
  console.log(`plan: ${item.model} (${item.modelName}) via ${item.autoVia ?? "explicit"}; quoted ${quoted} credits; fallbacks ${item.spec.fallbacks.slice(0, 3).join(", ")}`);

  const request = buildGenerateRequest(item.spec, model, []);
  const problems = requestProblems(model, request);
  if (problems.length) throw new Error(`request does not fit: ${problems.join("; ")}`);

  const provider = hyperouter.createHyperouterGenerationProvider(model, client);
  const key = newId("job");
  const { externalId } = await provider.submit(request, key);
  const again = await provider.submit(request, key);
  console.log(`submit: ${externalId} (key ${key}); re-submit with the same key → ${again.externalId} ${again.externalId === externalId ? "(same job)" : "(DIFFERENT JOB!)"}`);

  const status = await pollUntilDone(provider, externalId, {
    intervalMs: 2000,
    timeoutMs: 5 * 60_000,
    onStatus: (s) => console.log(`  status ${s.state} ${s.progress}%`),
  });
  if (status.state !== "succeeded") throw new Error(`job failed: ${JSON.stringify(status.error)}`);
  const output = status.outputs.find((o) => o.kind === "image");
  if (!output) throw new Error("no output");
  const res = await fetch(output.url);
  const bytes = (await res.arrayBuffer()).byteLength;
  console.log(`output: HTTP ${res.status} ${res.headers.get("content-type")} ${bytes} bytes`);

  const cost = status.costUsd;
  const charged = cost === null ? quoted : Math.min(quoted, creditsForUsd(cost));
  console.log(
    JSON.stringify(
      { model: item.model, externalId, costUsd: cost, quotedCredits: quoted, chargedCredits: charged, idempotent: again.externalId === externalId, seconds: (Date.now() - t0) / 1000 },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
