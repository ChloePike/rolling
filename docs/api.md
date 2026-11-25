# API

JSON over HTTPS under `/api`, served by the Hono Worker. Auth by session cookie. Every write takes and returns a `revision` where noted; a stale revision returns `409 CONFLICT` with the current state. Errors: `{ "error": { "code": "…", "message": "…", "data": {} } }`.

Payment-related error codes the UI must handle:
- `NO_PLAN` → open Paywall `variant=join`, keep the pending action.
- `INSUFFICIENT_CREDITS` (`data: { needed, balance }`) → Paywall `variant=credits`.
- `QUOTE_EXPIRED` → re-quote and show the new total.
- `MEMBER_LIMIT_REACHED` → tell the user their team limit for the month is used.

## Account and billing
| Method | Path | Notes |
|---|---|---|
| GET | `/api/me` | user, workspace, role, prefs, plan, balance `{ plan, purchased, held, planExpiresAt }` |
| PATCH | `/api/me/prefs` | language, currency, creationMode, defaultRatio, defaultModel, confirmThreshold, notifications |
| GET | `/api/billing/plans` | plans and packs with prices in the user’s currency |
| POST | `/api/billing/checkout` | `{ kind: plan|pack, priceId, resume?: { runQuoteId } }` → Stripe Checkout URL |
| POST | `/api/billing/portal` | → Stripe customer portal URL |
| PATCH | `/api/billing/auto-topup` | `{ enabled, threshold, packPriceId }` |
| GET | `/api/billing/ledger` | paged ledger lines for Activity and invoices |
| POST | `/api/stripe/webhook` | Stripe events (`constructEventAsync`, idempotent via `stripe_events`) |
| POST | `/api/hooks/:provider` | provider job webhooks → `workflow.sendEvent` |

## Workspaces and team
| GET | `/api/workspace/members` | |
| POST | `/api/workspace/invites` | `{ email, role }` |
| PATCH | `/api/workspace/members/:id` | `{ role?, monthlyCreditLimit? }` |

## Projects and graph
| GET | `/api/projects` | recent first |
| POST | `/api/projects` | `{ title, fromTemplateId? }` |
| GET | `/api/projects/:id` | canvas, nodes, edges, revision |
| POST | `/api/projects/:id/patch` | `{ baseRevision, ops: GraphOp[] }` → `{ revision }` (same ops the agent proposes; also accepted over the WebSocket) |
| GET | `/api/projects/:id/ws` | WebSocket to ProjectRoom: snapshot, then `graph.patched`, `node.version`, `job.progress`, `job.done`, `job.failed`, `timeline.patched`, `credits.changed`, `proposal.created`, `agent.delta`; client sends patches `{ baseRevision, ops }` |
| GET | `/api/nodes/:id/versions` | history; `POST /api/nodes/:id/active` `{ versionId }` |

## Runs
| POST | `/api/runs/quote` | `{ projectId, scope: node|selection|all, nodeIds? }` or `{ promptSpec }` from a tool page → `{ quoteId, items: [{ nodeId, action: run|reuse|blocked|none, model, credits, reason? }], total, balanceAfter, expiresAt }` |
| POST | `/api/runs` | `{ quoteId }` → `{ runId }` or `NO_PLAN` / `INSUFFICIENT_CREDITS` |
| POST | `/api/runs/:id/cancel` | releases holds of unfinished items |
| GET | `/api/runs` | Activity list: filters status, project, model, date |

## Assets and libraries
| POST | `/api/assets/upload-url` | `{ filename, contentType, size }` → signed PUT URL + assetId |
| POST | `/api/assets/:id/complete` | triggers probe, thumbnail, waveform |
| GET | `/api/assets` | `?scope=mine|team|builtin|public|all&kind=&q=` (powers the `@` picker) |
| GET | `/api/public-library` | `?category=&sub=&q=` with license |
| GET/POST | `/api/characters`, `/api/voices` | voice clone: `POST /api/voices/clone` `{ sampleAssetId }` (async job) |
| GET | `/api/templates` | |

## Agent
| POST | `/api/agent/threads` | `{ projectId?, surface: home|canvas|editor|tool, skill? }` |
| POST | `/api/agent/threads/:id/messages` | `{ text, refs: assetIds[], selection?: nodeIds[] }` → streamed response (text/event-stream from the AgentSession DO) of `text`, `tool`, `proposal`; also mirrored on the project WebSocket |
| POST | `/api/agent/proposals/:id/apply` | applies as the user; returns new revision; for `plan` proposals `{ optionIndex }` creates nodes |
| POST | `/api/agent/proposals/:id/discard` | |

## Editor
| GET | `/api/canvases/:id/timeline` | EDL + revision (assembled on first open) |
| POST | `/api/canvases/:id/timeline/patch` | `{ baseRevision, ops: TimelineOp[] }` |
| POST | `/api/canvases/:id/timeline/reassemble` | rebuild from script, keeps manual trims where shots match |
| POST | `/api/canvases/:id/export` | `{ preset: mp4_1080p }` → ExportWorkflow; result on the project WebSocket |

## Sharing
| POST | `/api/projects/:id/share` | `{ allowDownload }` → snapshot link; `DELETE` to stop sharing |
