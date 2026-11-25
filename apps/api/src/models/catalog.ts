import { syncModels } from "./sync";
/**
 * Reads the synced model catalog from D1 and shapes it for clients (D-002).
 * The overlay is merged at read time, so product changes apply on deploy
 * without waiting for the next sync.
 */
import { Catalog, creditsFor, type CatalogKind, type CatalogModel, type ListingModel, type PriceRule } from "@rolling/core";
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
      out.push({ ...data, price });
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
}

export interface PublicModel {
  id: string;
  kind: CatalogKind;
  name: string;
  tags: string[];
  default: boolean;
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
  /** Indicative credits: per resolution, for 5 s of video (or the model default) or one image. Quotes are exact. */
  credits: CreditSample[];
}

const SAMPLE_SECONDS = 5;

function creditSamples(m: CatalogModel): CreditSample[] {
  if (m.kind === "chat") return [];
  const samples: CreditSample[] = [];
  const resolutions: (string | null)[] = m.resolutions.length ? m.resolutions : [null];
  let seconds: number | null = null;
  if (m.kind === "video") {
    const s = m.seconds;
    const fits = !s || (s.allowed ? s.allowed.includes(SAMPLE_SECONDS) : SAMPLE_SECONDS >= s.min && SAMPLE_SECONDS <= s.max);
    seconds = fits ? SAMPLE_SECONDS : (m.defaultSeconds ?? s!.min);
  }
  for (const resolution of resolutions) {
    try {
      const credits = creditsFor(m, {
        ...(resolution !== null && { resolution }),
        ...(seconds !== null && { seconds }),
        ...(m.kind === "image" && !m.operations.includes("t2i") && { inputImages: Math.max(1, m.minInputImages) }),
      });
      samples.push({ resolution, seconds, credits });
    } catch {
      // Not priceable at this resolution: leave it out; quotes refuse it too.
    }
  }
  return samples;
}

export function toPublicModel(m: CatalogModel): PublicModel {
  return {
    id: m.id,
    kind: m.kind,
    name: m.displayName,
    tags: m.tags,
    default: m.default,
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
    credits: creditSamples(m),
  };
}

/** Visible models for a caller: never hidden ones; mature-only ones only when allowed (D-005). */
export async function listPublicModels(
  env: Env,
  user: SessionUser | null,
  kind?: CatalogKind | null,
): Promise<PublicModel[]> {
  const [catalog, mature] = await Promise.all([loadCatalog(env, kind), mayViewMature(env, user)]);
  return catalog.list({ ...(kind && { kind }), includeMatureOnly: mature }).map(toPublicModel);
}
