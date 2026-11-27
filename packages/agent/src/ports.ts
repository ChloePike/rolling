/**
 * Ports: everything the harness reads from the outside world. The
 * AgentSession Durable Object wires real implementations (ProjectRoom, D1,
 * CreditAccount, the synced catalog); tests and evals use in-memory fakes.
 * Ports only read. Nothing here mutates state or spends credits.
 */
import type { CatalogModel, ListingModel, PriceRequest } from '@rolling/core';
import type { PlanId } from '@rolling/core/pricing/config';
import type { GraphState } from '@rolling/core/graph';
import type { Edl } from '@rolling/core/timeline';
import type { SafetyGate } from '@rolling/core/safety';
import type { ReviewSummary } from '@rolling/core/review';

export interface CanvasPort {
  /** Current graph of a project, or null when it does not exist / is not readable. */
  getGraph(projectId: string): Promise<{ state: GraphState; assets: Record<string, string>; reviews?: Record<string, ReviewSummary> } | null>;
}

export type AssetScope = 'mine' | 'team' | 'builtin' | 'public' | 'all';
export type AssetKind = 'image' | 'video' | 'audio' | 'text';

export interface AssetItem {
  id: string;
  name: string;
  kind: AssetKind;
  /** mine, team, builtin, public, generated, character. */
  source: string;
  license?: string | null;
  /** Short description (prompt text, tags). */
  description?: string;
}

export interface NamedItem {
  id: string;
  name: string;
  description?: string;
}

/** A saved character (D-032): its locked descriptor words and the sheet of its current version. */
export interface CharacterItem extends NamedItem {
  kind?: 'person' | 'animal' | 'object';
  /** Locked look (face, hair, build), the words every shot repeats. */
  look?: string;
  /** Default outfit. */
  wardrobe?: string;
  /** Sheet pictures of the current version: view → asset id. */
  sheet?: Partial<Record<string, string>>;
  /** Outfit variants with their body views. */
  outfits?: Array<{ name: string; outfit: string; views: Partial<Record<string, string>> }>;
}

export interface AssetsPort {
  search(query: { query: string; scope: AssetScope; kind?: AssetKind; limit: number }): Promise<AssetItem[]>;
  /** Resolves `@` references by id; unknown ids are left out. */
  resolve(ids: readonly string[]): Promise<AssetItem[]>;
  characters(): Promise<CharacterItem[]>;
  voices(): Promise<NamedItem[]>;
}

export interface ModelsPort {
  /** Generation models (video, image) of the synced catalog, overlay merged. */
  models(): readonly CatalogModel[];
  get(id: string): CatalogModel | undefined;
  /** Credits for one request, or null when the listing cannot price it. */
  creditsFor(model: CatalogModel, request: PriceRequest): number | null;
  /** Chat models in the catalog (for public LLM routing, D-009). */
  chatModels(): readonly Pick<ListingModel, 'id' | 'price'>[];
}

export interface AccountSnapshot {
  plan: PlanId | null;
  balance: { plan: number; purchased: number; held: number };
  /** Runs above this need a confirm (D-006). */
  confirmThreshold: number;
  creationMode: 'simple' | 'advanced';
  /** UI language (BCP 47 subset from prefs). Replies use it. */
  language: string;
  /** D-005: member, mature preference on and allowed by the workspace. */
  matureAllowed: boolean;
}

export interface AccountPort {
  get(): Promise<AccountSnapshot>;
}

export interface TemplateItem {
  id: string;
  name: string;
  description?: string;
  /** Slots the user fills (e.g. product photo, logo, tagline). */
  slots: string[];
}

export interface TemplatesPort {
  search(query: string, limit: number): Promise<TemplateItem[]>;
}

export interface TimelinePort {
  /** Current EDL of a canvas, or null when the canvas has no timeline. */
  get(canvasId: string): Promise<{ revision: number; edl: Edl } | null>;
}

export interface AgentPorts {
  canvas: CanvasPort;
  assets: AssetsPort;
  models: ModelsPort;
  account: AccountPort;
  templates: TemplatesPort;
  timeline: TimelinePort;
  /**
   * D-005 hard limits (core/safety): checks the user's brief at the start of a
   * turn and every proposal's generation prompts. AgentSession always wires it;
   * the generation pipeline checks again before anything runs.
   */
  safety?: SafetyGate;
}
