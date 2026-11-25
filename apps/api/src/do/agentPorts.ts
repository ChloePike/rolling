/**
 * Real ports for the agent harness (`@rolling/agent`), read-only, built per
 * turn inside AgentSession: ProjectRoom (graph, timeline), D1 (assets,
 * characters, voices, templates), the synced catalog and CreditAccount.
 */
import { catalogModelsPort, type AccountSnapshot, type AgentPorts, type AssetItem, type AssetKind } from "@rolling/agent";
import type { PlanId } from "@rolling/core/pricing/config";
import { loadCatalog } from "../models/catalog";
import { canvasIdFor, type RoomCaller } from "./ProjectRoom";

/** Who the turn runs for. Resolved by the Worker from the auth context; the DO trusts it. */
export interface AgentCaller {
  userId: string;
  workspaceId: string;
  role: "owner" | "editor" | "viewer";
  plan: PlanId | null;
  matureAllowed: boolean;
  language: string;
  creationMode: "simple" | "advanced";
  confirmThreshold: number;
}

export function roomCallerOf(caller: AgentCaller): RoomCaller {
  return { userId: caller.userId, workspaceId: caller.workspaceId, canEdit: caller.role !== "viewer" };
}

function room(env: Env, projectId: string) {
  return env.PROJECT.get(env.PROJECT.idFromName(projectId));
}

function isError(v: unknown): boolean {
  return typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;
}

function parseMeta(raw: string | null | undefined): Record<string, unknown> {
  try {
    const v: unknown = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface AssetRow {
  id: string;
  name: string;
  kind: AssetKind;
  source: string;
  license: string | null;
  meta: string;
}

function assetItem(r: AssetRow): AssetItem {
  const meta = parseMeta(r.meta);
  const description = [meta.description, meta.prompt, meta.promptEn].find((x) => typeof x === "string") as string | undefined;
  return { id: r.id, name: r.name, kind: r.kind, source: r.source, license: r.license, ...(description ? { description: description.slice(0, 200) } : {}) };
}

export async function balanceOf(env: Env, workspaceId: string): Promise<AccountSnapshot["balance"]> {
  try {
    const stub = env.CREDITS.get(env.CREDITS.idFromName(workspaceId)) as unknown as { balance(): Promise<{ plan: number; purchased: number; held: number }> };
    const b = await stub.balance();
    return { plan: b.plan, purchased: b.purchased, held: b.held };
  } catch (err) {
    console.error(JSON.stringify({ msg: "agent: balance unavailable", workspaceId, error: String(err) }));
    return { plan: 0, purchased: 0, held: 0 };
  }
}

export async function agentPorts(env: Env, caller: AgentCaller): Promise<AgentPorts> {
  const rc = roomCallerOf(caller);
  const catalog = await loadCatalog(env, null);
  const ws = caller.workspaceId;
  const mature = caller.matureAllowed ? 1 : 0;
  return {
    canvas: {
      async getGraph(projectId) {
        const res = await room(env, projectId).getGraph(rc);
        return isError(res) ? null : (res as unknown as { state: never; assets: Record<string, string> });
      },
    },
    timeline: {
      async get(canvasId) {
        const projectId = /^cnv_[A-Za-z0-9]+$/.test(canvasId) ? `prj_${canvasId.slice(4)}` : null;
        if (!projectId) return null;
        const res = await room(env, projectId).getTimeline(rc, canvasId);
        if (isError(res)) return null;
        const t = (res as unknown as { timeline: { revision: number; edl: never } }).timeline;
        return { revision: t.revision, edl: t.edl };
      },
    },
    assets: {
      async search({ query, scope, kind, limit }) {
        const sources = scope === "all" ? null : scope;
        const like = `%${query.replace(/[%_]/g, " ").trim()}%`;
        const rows = await env.DB.prepare(
          `SELECT id, name, kind, source, license, meta FROM assets
           WHERE (workspace_id = ?1 OR source IN ('builtin','public'))
             AND (?2 IS NULL OR source = ?2) AND (?3 IS NULL OR kind = ?3)
             AND (mature = 0 OR ?4 = 1) AND (?5 = '%%' OR name LIKE ?5 OR meta LIKE ?5)
           ORDER BY created_at DESC LIMIT ?6`,
        )
          .bind(ws, sources, kind ?? null, mature, like, limit)
          .all<AssetRow>();
        return rows.results.map(assetItem);
      },
      async resolve(ids) {
        if (!ids.length) return [];
        const rows = await env.DB.prepare(
          `SELECT id, name, kind, source, license, meta FROM assets WHERE id IN (${ids.map(() => "?").join(",")})
           AND (workspace_id = ? OR source IN ('builtin','public')) AND (mature = 0 OR ? = 1)`,
        )
          .bind(...ids.slice(0, 20), ws, mature)
          .all<AssetRow>();
        return rows.results.map(assetItem);
      },
      async characters() {
        const rows = await env.DB.prepare("SELECT id, name, meta FROM characters WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 30").bind(ws).all<{ id: string; name: string; meta: string | null }>();
        return rows.results.map((r) => {
          const d = parseMeta(r.meta).description;
          return { id: r.id, name: r.name, ...(typeof d === "string" ? { description: d.slice(0, 200) } : {}) };
        });
      },
      async voices() {
        const rows = await env.DB.prepare("SELECT id, name, language, kind FROM voices WHERE (workspace_id = ? OR kind = 'builtin') AND status != 'failed' LIMIT 40")
          .bind(ws)
          .all<{ id: string; name: string; language: string | null; kind: string }>();
        return rows.results.map((r) => ({ id: r.id, name: r.name, description: [r.kind, r.language].filter(Boolean).join(", ") }));
      },
    },
    models: catalogModelsPort(catalog),
    account: {
      async get() {
        return {
          plan: caller.plan,
          balance: await balanceOf(env, ws),
          confirmThreshold: caller.confirmThreshold,
          creationMode: caller.creationMode,
          language: caller.language,
          matureAllowed: caller.matureAllowed,
        };
      },
    },
    templates: {
      async search(query, limit) {
        const like = `%${query.replace(/[%_]/g, " ").trim()}%`;
        const rows = await env.DB.prepare(
          "SELECT id, title, category, slots FROM templates WHERE (workspace_id IS NULL OR workspace_id = ?) AND (? = '%%' OR title LIKE ? OR category LIKE ?) ORDER BY uses DESC LIMIT ?",
        )
          .bind(ws, like, like, like, limit)
          .all<{ id: string; title: string; category: string | null; slots: string }>();
        return rows.results.map((r) => {
          let slots: string[] = [];
          try {
            const v: unknown = JSON.parse(r.slots);
            if (Array.isArray(v)) slots = v.map((s) => (typeof s === "string" ? s : String((s as { label?: unknown; name?: unknown }).label ?? (s as { name?: unknown }).name ?? ""))).filter(Boolean);
          } catch {
            // Unreadable slots.
          }
          return { id: r.id, name: r.title, ...(r.category ? { description: r.category } : {}), slots };
        });
      },
    },
  };
}

export { canvasIdFor };
