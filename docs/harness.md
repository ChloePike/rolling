# Agent harness

The agent turns a brief into a plan, builds nodes, fills prompts and settings, edits the timeline, and explains costs. It never spends credits and never applies changes without the user. It is available to members only (`docs/decisions.md` D-007). Logic lives in `packages/agent`; it runs inside the `AgentSession` Durable Object (one per thread), which stores messages and proposals in its SQLite and streams events to the browser.

## 1. Where the agent appears

| Surface | Entry | Output |
|---|---|---|
| Home, Agent mode | prompt box (+ skill chip, @ refs) | plan options → “Build on canvas” creates a project with nodes |
| Canvas agent panel | chat composer | node patches (create, update params, connect, delete) shown as a diff |
| Editor | “Ask for an edit” field | timeline patch shown as a proposal card + outlines on the timeline |
| Tools (Quick Create, Remix, Avatar, Characters) | Refine / free text in Simple mode | structured fields filled from free text (no graph) |

## 2. Loop

```
user message (+ context refs)
  → build context (§4)
  → LLM call with tools (streaming)
      ├─ read tools: run freely, results appended, loop
      ├─ propose tools: validated, stored as a Proposal, streamed to UI, loop ends for this turn
      └─ text: streamed to UI
  → turn ends when the model stops calling tools or after max 8 tool calls
```

- One proposal per turn. A proposal is a typed patch (§5) plus a summary, cost estimate and risk notes. The UI shows it; the user clicks Apply / Build on canvas / Discard. Apply goes through the normal API as the user (`ProjectRoom.applyPatch`).
- If the user edits the canvas while a proposal is pending, the proposal is rebased against the new revision; if it no longer applies cleanly it is marked stale and the agent is told on the next turn.
- Cancel: the user can stop a turn; partial text stays, no proposal is created.

## 3. Tools

All inputs validated with Zod; all results compact JSON. Read tools never mutate. Propose tools never mutate either; they create proposals.

| Tool | Kind | Input → Output |
|---|---|---|
| `canvas.get` | read | `{ projectId, nodeIds? }` → nodes (kind, title, params, active version summary, status, cost), edges, revision |
| `script.get` | read | `{ nodeId }` → scenes and shots with fields |
| `assets.search` | read | `{ query, scope: mine|team|builtin|public|all, kind? }` → items with id, name, kind, source, license |
| `characters.list`, `voices.list` | read | → items |
| `models.capabilities` | read | `{ kind: video|image|avatar }` → models with modes, limits, price per unit |
| `pricing.estimate` | read | `{ items: [{ model, kind, seconds?, count?, resolution? }] }` → credits per item and total |
| `account.get` | read | → plan, balance (plan/purchased/held), confirm threshold, creation mode, language |
| `templates.search` | read | `{ query }` → templates with slots |
| `timeline.get` | read | `{ canvasId }` → EDL summary (tracks, clips with ids, durations, gaps) |
| `propose.plan` | propose | `{ options: [{ title, shots: [{ title, seconds, visual, line?, model }], estimate }] }` (2–3 options) |
| `propose.graphPatch` | propose | `{ projectId, baseRevision, ops: GraphOp[], summary }` |
| `propose.timelinePatch` | propose | `{ canvasId, baseRevision, ops: TimelineOp[], summary }` |
| `propose.fields` | propose | `{ tool: quick|remix|avatar|character, fields: {...} }` (Simple mode free text → structured) |

There is intentionally no `run`, `buy`, `delete project`, or `share` tool.

## 4. Context assembly

Built per turn, budgeted to ~24k tokens:

1. System prompt (`prompts/system.md`): role, the rules in §6, output style, the patch formats.
2. Skill prompt if a skill is active (`skills/<id>/SKILL.md`, e.g. `tv-ad`, `ai-comic`, `product-showcase`, `storyboard`, `brand-kit`): workflow steps, shot conventions, default durations, recommended models.
3. Account snapshot from `account.get` (plan, balance, threshold, language) — so the agent can warn about cost without being asked.
4. Workspace context: selected nodes (full), the rest of the canvas as a one-line-per-node summary, script node if present, `@` references (resolved to ids + short descriptions), brand kit if set.
5. Conversation: last 12 messages verbatim, older messages summarized into the thread’s `summary` field (updated every 10 turns).
6. Reply language = user’s UI language; prompts sent to generation models are written in English regardless (better model adherence), and the user can view them in the run confirm.

## 5. Patch formats

```ts
type GraphOp =
  | { op: 'addNode', tempId: string, kind: NodeKind, title: string, params: NodeParams, position?: { x: number, y: number } }
  | { op: 'updateNode', nodeId: string, params: Partial<NodeParams>, title?: string }
  | { op: 'connect', from: { node: string, port: string }, to: { node: string, port: string } }
  | { op: 'disconnect', edgeId: string }
  | { op: 'removeNode', nodeId: string }           // only nodes the agent created in this thread unless the user asked
  | { op: 'group', nodeIds: string[], title: string }

type TimelineOp =
  | { op: 'trim', clipId: string, in?: number, out?: number }
  | { op: 'move', clipId: string, start: number }
  | { op: 'split', clipId: string, at: number }
  | { op: 'remove', clipId: string, ripple: boolean }
  | { op: 'setGain', clipId: string, gainDb: number }
  | { op: 'setCaption', clipId: string, text: string }
  | { op: 'replaceShot', clipId: string, nodeId: string }   // after a regenerate
```
Validation before a proposal is stored: schema; ids exist; port types and no cycles (`core/graph/validate`); model capabilities satisfied; timeline has no overlaps on a track; estimate computed with `pricing.estimate`. Invalid → the error is returned to the model as a tool result and it retries (max 2), else it explains the problem in text.

Layout: new nodes are placed by `core/graph/layout` (left-to-right by dependency), never by the model’s guessed coordinates unless the user dragged them.

## 6. Rules the agent follows (in the system prompt)

- Never claim something was generated, charged or applied; say what the proposal will do.
- Always give a credit estimate for anything that will cost credits, and say when something is free (building nodes, trimming, planning).
- Prefer reuse: if a valid version exists, reuse it; propose regeneration only for what the user asked to change.
- Keep the user’s words: when filling fields from free text, preserve their wording and order of interactions.
- Ask one short question only when a choice changes cost by more than 2× or the brief is contradictory; otherwise pick sensible defaults and say which.
- Use the user’s language in replies; sentence case; no hype words; no emoji.
- Respect Simple/Advanced: in Simple mode don’t expose seeds, negative prompts or model internals unless asked.

## 7. Models

`LlmProvider` interface with DeepSeek as the default implementation (OpenAI-compatible chat completions with tools, streaming). Temperature 0.3 for planning and patches, 0.7 for script writing. Verify tool-calling support and context length of the deployed DeepSeek version; if tool calls are unreliable, fall back to JSON-mode output parsed against the same Zod schemas. Keep the provider swappable. Calls are plain `fetch` from the DO; keep a turn under the DO request limits by streaming and capping tool calls at 8.

## 8. Evals (`packages/agent/evals`)

- A set of 40 golden briefs across skills (TV ad, product showcase, talking head, comic, character) with expected properties, not exact outputs: shot count range, total duration within ±10% of the brief, every shot has a model that supports its mode, estimate within the user’s balance hint, no forbidden ops.
- Timeline edit cases: “cut to 10s”, “swap shot 2 and 3”, “lower the music”, “make captions shorter” → check resulting EDL invariants (duration, no overlaps, captions aligned with voice).
- Run evals in CI on prompt or skill changes; track pass rate, tokens per turn, proposal acceptance rate in production (applied / proposed).

## 9. Telemetry

Per turn: tokens in/out, tool calls, latency, proposal type, validation retries. Per proposal: applied, discarded, stale, time to decision. These feed the eval set: discarded proposals with a user follow-up are candidates for new golden cases.
