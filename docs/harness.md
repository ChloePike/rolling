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

## 10. Implementation (M6)

Where things live and the decisions made while building. Sections 1–9 stay the spec; this records how it is met.

- **Package** `packages/agent` (pure TS, Workers-safe): `loop.ts` (turn loop), `tools/` (Zod v4 schemas → JSON Schema for the model, read tools over ports, compact JSON views), `proposals.ts` (propose validation, plan → GraphOps, rebase), `capabilities.ts` (model checks, plan caps, estimates), `context.ts` (assembly and budget), `layout.ts`, `routing.ts`, `summary.ts`, `telemetry.ts`, `limits.ts`, `testkit.ts` (memory ports, scripted LLM). Prompts are Markdown (`prompts/system.md`, `skills/<id>/SKILL.md`) bundled into `src/prompts.generated.ts` by `pnpm --filter @rolling/agent gen:prompts`; a test fails when the bundle is stale.
- **Ports** (`src/ports.ts`): `CanvasPort`, `AssetsPort`, `ModelsPort` (catalog + `creditsFor`), `AccountPort`, `TemplatesPort`, `TimelinePort`. Read-only. The DO wires them in `apps/api/src/do/agentPorts.ts` (ProjectRoom RPCs as the user, D1, synced catalog, CreditAccount balance).
- **Surfaces → tools.** home: reads + `propose.plan`; canvas: + `canvas.get`, `script.get`, `propose.graphPatch`, `propose.plan`; editor: + `timeline.get`, `propose.timelinePatch`; tool: reads + `propose.fields` (the thread's `tool` says which form). No run, buy, delete-project or share tool exists.
- **Loop.** Parallel tool calls off; read tools run in order; the first valid proposal ends the turn (other propose calls in the same response are answered "one proposal per turn"). Invalid proposals return the error text to the model; after the third invalid call (2 retries) the next call is text-only (`tool_choice: none`) and the turn ends with `invalid_proposal`. After 8 tool calls one text-only call explains (`max_tool_calls`). An LLM call that fails before producing anything is retried once. Cancel aborts the stream; partial text is kept, no proposal. Every LLM call carries an idempotency key `<turnId>:<n>`.
- **Validation details.** Plans: the model passes the target `seconds`; every option must add up to it within 10%; per shot the model must exist, be general-purpose (no identity/swap/tool models), support the mode (i2v when the model can, else t2v), take the length (whole seconds in range) and the resolution (model default unless the option sets one; plan cap per `planAllowsResolution`), and the ratio. When every option costs more than the available balance but a cheaper model would fit, the plan is refused with the cheapest model as a hint. Errors name a valid shot split (`suggestSplit`), since models get the arithmetic wrong. Graph patches: `baseRevision` must be current; `applyGraphOps` (ports, types, cycles, ids) on the current state; temp ids may not look like node ids; removing user-made nodes needs an explicit ask in the user's message; every added or changed video/image node passes the same model checks and is priced. Timeline patches: `baseRevision` current; `applyOps` from core (no overlaps, minimum clip length). Fields: per-tool Zod schema; quick runs are model-checked and priced. Mature-only models need `matureAllowed` (D-005).
- **Model quirks handled.** DeepSeek V4.1 Flash sometimes sends nested arrays as JSON strings on retries, sometimes with the rest of the object (or its own parameter markup, `"seconds" string="false">6`) inside the string; `decodeJsonStrings` repairs these before validation.
- **Estimates** are the credits the follow-up runs would cost at list price (`creditsFor`): plan options = keyframes + shots; graph patches = added or changed generative nodes; timeline patches and fields without a model = 0. Applying a proposal is always free. Risks are codes (`over_balance`, `needs_confirm`, `unpriced`, `removes_user_nodes`); the UI owns the copy.
- **Plan → canvas.** One `script` node (rows), `asset` nodes for `@` images, per shot an image keyframe (default image model; `edit` mode wired to the refs) and a video node fed by it. Layout: `layoutNewNodes` (no `core/graph` layout exists yet): a new node goes one column right of its rightmost input, first column otherwise, below whatever is in its column; model coordinates are ignored.
- **Context.** System prompt + active skill + account snapshot + workspace (surface, tool, canvas revision, selected nodes in full, other nodes one line each, edges, script, timeline summary in the editor, `@` refs resolved, stale proposals) + summary + last 12 messages + the user message, cut to fit 24k tokens minus 4k headroom and the tool definitions (estimator: ~4 chars per token for Latin text, 1 per CJK character, plus JSON punctuation). Stored messages carry a note of the proposal they created and its status. Tool traces are not stored; tool results are capped at 3k tokens.
- **Summary** every 10 turns once messages leave the 12-message window: one LLM call without tools, deterministic fallback on failure.
- **Routing (D-009).** The thread's public LLM id (or the request's `llm`) resolves with `resolveChatModel`; unknown or unavailable ids fall back to `deepseek-v4.1-flash` (cheapest of `-flash` / `-flash-us`). Mature turns route per the public entry (D-005). Temperature 0.3, or 0.7 when the user asks for writing (script, lines, story) and not for an edit; editor and tool turns are 0.3. `reasoning_effort: "none"` for DeepSeek (every agent turn uses tools).
- **Rebase/stale.** Before each turn and on apply, pending graph/timeline proposals are re-checked against the current revision: the same ops still apply → `baseRevision` moves (rebased); otherwise `stale` with the reason, broadcast as `proposal.updated` and listed to the model next turn. Apply always sends exactly the stored ops.
- **Telemetry** (Analytics Engine `AE`, see `telemetry.ts` for blob/double positions): per turn tokens in/out, estimated context tokens, cost, tool calls, LLM calls, retries, latency, end reason, proposal kind; per proposal decision kind, status (applied/discarded/stale), time to decision, estimate.

### Evals

`packages/agent/evals`: 40 golden briefs (`BRIEFS`: TV ad 10, product showcase 8, storyboard 5, comic 6, brand kit 3, talking head 4, character 4), canvas cases (golden-path “make shot 2 warmer”, length change, add a shot, selection; quick and remix fields) and timeline cases (“cut to 10s”, “swap shot 2 and 3”, “lower the music”, “make captions shorter”, cut to 12 s, remove a shot). Invariants (`invariants.ts`): proposal kind; 2–3 options; shot count range; every option's length within ±10%; every shot's model supports its mode, length, resolution (plan) and ratio; plan ops are only `addNode`/`connect` and apply; cheapest option within the balance hint; fields keep the user's words; graph patches apply, touch only the asked nodes (script sync allowed), no user-node removal, no forbidden ops; EDL has no overlaps, no shot under 1 s, captions stay on the picture, target duration ±0.05 s, swaps reorder, music lower with voice unchanged, captions shorter with unchanged timing; replies have no emoji and no "I have generated/applied" claims.

- CI: `evals/ci.test.ts` runs every case through the real loop with a scripted LLM (one read, then the propose call; every fifth plan sends an invalid first proposal), plus the retry, invalid-proposal, max-tool-calls and cancel paths. Part of `pnpm -r test`.
- Live: `HYPEROUTER_API_KEY=... pnpm --filter @rolling/agent eval:live [--llm id] [--only prefix,...] [--concurrency n] [--repeat n]` writes `evals/results/live-*.json` (git-ignored) and exits 1 below 90%.
