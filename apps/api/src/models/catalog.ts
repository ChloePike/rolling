import { syncModels } from "./sync";
import { gatewayFeatureEnabled } from "./features";
/**
 * Reads the synced model catalog from D1 and shapes it for clients (D-002).
 * The overlay is merged at read time, so product changes apply on deploy
 * without waiting for the next sync.
 */
import { availableChatModels, Catalog, creditsFor, expansionWriter, promptExpansionMaxUsd, type CatalogKind, type CatalogModel, type ListingModel, type PriceRule } from "@rolling/core";
import type { ModelRow } from "@rolling/db/d1";
import { listModelRows, userMayViewMatureModels } from "@rolling/db/queries/models";
import type { SessionUser } from "../lib/session";

/** Rebuilds listing models from D1 rows. Rows that do not parse are skipped and logged. */
export function listingModelsFromRows(rows: readonly ModelRow[]): ListingModel[] {
  const out: ListingModel[] = [];
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data) as Omit<ListingModel, "price">;
      const price = JSON.parse(row.price) as PriceRule[];
      if (data.id !== row.id || !Array.isArray(price)) throw new Error("row does not match its id");
      // Rows synced before D-020 have no `params.promptExpand`: derive it from the accepted parameters.
      const params = data.params && typeof data.params.promptExpand !== "boolean"
        ? { ...data.params, promptExpand: data.kind !== "chat" && Array.isArray(data.acceptedParams) && data.acceptedParams.includes("prompt_expand") }
        : data.params;
      out.push({ ...data, params, price });
    } catch (err) {
      console.error(JSON.stringify({ msg: "models: unreadable row skipped", id: row.id, error: String(err) }));
    }
  }
  return out;
}

export async function loadCatalog(env: Env, kind?: CatalogKind | null): Promise<Catalog> {
  let rows = await listModelRows(env.DB, { kind: kind ?? null });
  if (rows.length === 0 && (await listModelRows(env.DB, { kind: null })).length === 0) {
    // Fresh environment: the cron has not run yet, so sync once on first read.
    await syncModels(env).catch((err: unknown) => {
      console.error(JSON.stringify({ msg: "models: bootstrap sync failed", error: String(err) }));
    });
    rows = await listModelRows(env.DB, { kind: kind ?? null });
  }
  return Catalog.fromListingModels(listingModelsFromRows(rows));
}

/** D-005: no session never sees mature-only models. */
export async function mayViewMature(env: Env, user: SessionUser | null): Promise<boolean> {
  if (!user) return false;
  return userMayViewMatureModels(env.DB, user.id, Date.now());
}

export interface CreditSample {
  resolution: string | null;
  seconds: number | null;
  credits: number;
  /**
   * D-020: the same run with "Enhance prompt", the rewrite's most included (the non-mature writer, a typical
   * prompt), so local estimates match the quote. Only on models that take the expansion while it is available.
   */
  enhanced?: number;
}

/** Prompt size the `enhanced` samples assume (the rewrite's most barely moves with the prompt on the cheap writer). */
const SAMPLE_EXPANSION_SIZE = { promptChars: 500, pictures: 0 };

export interface PublicModel {
  id: string;
  kind: CatalogKind;
  name: string;
  tags: string[];
  default: boolean;
  /** Picker placement: featured main list, behind "More models", or tool-only. */
  placement: "featured" | "more" | "tool";
  auto: boolean;
  mature: boolean;
  matureOnly: boolean;
  requiresIdentitySafety: boolean;
  substituteFor: string | null;
  operations: string[];
  seconds: { min: number; max: number; allowed: number[] | null } | null;
  defaultSeconds: number | null;
  resolutions: string[];
  defaultResolution: string | null;
  ratios: string[];
  audio: boolean;
  lipSync: boolean;
  limits: {
    referenceImages: number;
    referenceVideos: number;
    referenceAudios: number;
    inputImages: number;
    imagesPerRequest: number;
  };
  /**
   * Credits per resolution: one image, or video at 5 s (or the model default) first and then every other whole
   * length the model takes, each priced on its own as a quote would price it.
   */
  credits: CreditSample[];
  /**
   * D-020 "Enhance prompt": `available` when the model takes the gateway's prompt expansion, `unavailable` while the
   * gateway refuses the feature in this environment (the toggle says "Not available yet"), null when the model does not take it.
   */
  promptExpand: "available" | "unavailable" | null;
}

const SAMPLE_SECONDS = 5;

/** Longest range of whole seconds listed one by one; longer ranges list only the 5 s sample and the default. */
const MAX_SECOND_SAMPLES = 60;

/**
 * Lengths a video model is sampled at: the 5 s sample (or the default) first, then every other whole
 * length it takes. Each is priced on its own (`creditsFor` rounds up once per request), so a client
 * never scales a rounded 5 s price: 10 s of a model at 182 credits per 5 s can be 363, not 364.
 */
function sampleSeconds(m: CatalogModel): (number | null)[] {
  if (m.kind !== "video") return [null];
  const s = m.seconds;
  const fits = !s || (s.allowed ? s.allowed.includes(SAMPLE_SECONDS) : SAMPLE_SECONDS >= s.min && SAMPLE_SECONDS <= s.max);
  const first = fits ? SAMPLE_SECONDS : (m.defaultSeconds ?? s!.min);
  if (!s) return [first];
  const all = s.allowed ?? (s.max - s.min < MAX_SECOND_SAMPLES ? Array.from({ length: Math.floor(s.max) - Math.ceil(s.min) + 1 }, (_, i) => Math.ceil(s.min) + i) : []);
  return [first, ...all.filter((x) => x !== first && Number.isInteger(x) && x > 0)];
}

function creditSamples(m: CatalogModel, expandUsd: number | null): CreditSample[] {
  if (m.kind === "chat") return [];
  const samples: CreditSample[] = [];
  const resolutions: (string | null)[] = m.resolutions.length ? m.resolutions : [null];
  for (const resolution of resolutions) {
    for (const seconds of sampleSeconds(m)) {
      try {
        const req = {
          ...(resolution !== null && { resolution }),
          ...(seconds !== null && { seconds }),
          ...(m.kind === "image" && !m.operations.includes("t2i") && { inputImages: Math.max(1, m.minInputImages) }),
        };
        const credits = creditsFor(m, req);
        const enhanced = expandUsd !== null && m.params.promptExpand ? creditsFor(m, { ...req, promptExpandUsd: expandUsd }) : undefined;
        samples.push({ resolution, seconds, credits, ...(enhanced !== undefined && { enhanced }) });
      } catch {
        // Not priceable at this resolution: leave it out; quotes refuse it too.
      }
    }
  }
  return samples;
}

/**
 * `expandUsd`: the rewrite's most (D-020) priced into the `enhanced` samples; null leaves them out (feature off,
 * or no chat models to price the writer).
 */
export function toPublicModel(m: CatalogModel, expandAvailable = true, expandUsd: number | null = null): PublicModel {
  return {
    id: m.id,
    kind: m.kind,
    name: m.displayName,
    tags: m.tags,
    default: m.default,
    placement: m.placement,
    auto: m.auto,
    mature: m.mature,
    matureOnly: m.matureOnly,
    requiresIdentitySafety: m.requiresIdentitySafety,
    substituteFor: m.substituteFor ?? null,
    operations: m.operations,
    seconds: m.seconds ? { min: m.seconds.min, max: m.seconds.max, allowed: m.seconds.allowed ?? null } : null,
    defaultSeconds: m.defaultSeconds ?? null,
    resolutions: m.resolutions,
    defaultResolution: m.defaultResolution ?? null,
    ratios: m.ratios,
    audio: m.audio,
    lipSync: m.lipSync,
    limits: {
      referenceImages: m.maxReferenceImages,
      referenceVideos: m.maxReferenceVideos,
      referenceAudios: m.maxReferenceAudios,
      inputImages: m.maxInputImages,
      imagesPerRequest: m.maxImagesPerRequest,
    },
    credits: creditSamples(m, expandAvailable ? expandUsd : null),
    promptExpand: m.kind !== "chat" && m.params.promptExpand ? (expandAvailable ? "available" : "unavailable") : null,
  };
}

/** Visible models for a caller: never hidden ones; mature-only ones only when allowed (D-005). */
export async function listPublicModels(
  env: Env,
  user: SessionUser | null,
  kind?: CatalogKind | null,
): Promise<PublicModel[]> {
  const [catalog, mature, expandAvailable] = await Promise.all([loadCatalog(env, kind), mayViewMature(env, user), gatewayFeatureEnabled(env, "prompt_expand")]);
  // D-020: the non-mature writer's most for a typical prompt, so "Enhance prompt" estimates match the quote.
  const chatCatalog = !kind || kind === "chat" ? catalog : expandAvailable ? await loadCatalog(env, "chat") : null;
  const writers = chatCatalog ? chatCatalog.list({ kind: "chat", includeHidden: true, includeMatureOnly: true }) : [];
  const expandUsd = expandAvailable ? promptExpansionMaxUsd(writers, expansionWriter(writers, { mature: false }), SAMPLE_EXPANSION_SIZE) : null;
  // Chat models are exposed only as the public agent LLM list (D-009), never as gateway ids.
  const media = catalog
    .list({ ...(kind && { kind }), includeMatureOnly: mature })
    .filter((m) => m.kind !== "chat")
    .map((m) => toPublicModel(m, expandAvailable, expandUsd));
  if (kind && kind !== "chat") return media;
  const chatGateway = catalog.list({ kind: "chat", includeMatureOnly: true });
  const chat = availableChatModels(chatGateway).map(
    (m): PublicModel => ({
      id: m.id,
      kind: "chat",
      name: m.name,
      tags: [],
      default: m.default === true,
      placement: "featured",
      auto: false,
      mature: m.matureRoute !== undefined,
      matureOnly: false,
      requiresIdentitySafety: false,
      substituteFor: null,
      operations: ["chat"],
      seconds: null,
      defaultSeconds: null,
      resolutions: [],
      defaultResolution: null,
      ratios: [],
      audio: false,
      lipSync: false,
      limits: { referenceImages: 0, referenceVideos: 0, referenceAudios: 0, inputImages: 0, imagesPerRequest: 0 },
      credits: [],
      promptExpand: null,
    }),
  );
  return kind === "chat" ? chat : [...media, ...chat];
}
