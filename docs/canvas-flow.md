# Canvas golden path (acceptance)

The canvas flow is the product’s core. This is the end-to-end path the lead tests on staging with Playwright against the real backend (no mocks). Every step must work with mouse and keyboard, survive a reload, and stay in sync across two tabs.

| # | Step | Frontend | Backend |
|---|---|---|---|
| 1 | Member opens Home, Agent mode, types a brief (“15-second vertical ad for a sparkling water…”) with the TV ad skill and an `@` product photo, sends | Home prompt box | AgentSession turn (DeepSeek V4.1 Flash by default), `propose.plan` with 2–3 options and estimates |
| 2 | Picks an option, **Build on canvas** | Plan card | Creates a project, applies the plan as GraphOps (no spend), navigates to `/p/:id` |
| 3 | Canvas shows script, image keyframe and video nodes connected with typed ports; layout left-to-right | Canvas | ProjectRoom snapshot over WS |
| 4 | User edits a node prompt and a param (resolution within plan cap), connects/disconnects a port (an invalid one is refused with a reason) | Node cards, prompt panel | `patch` → `ack`; refusal reason from core/graph validation |
| 5 | **Run all** → quote dialog lists run / reuse / blocked rows with credits and balance after | RunConfirm (plan) | `POST /api/runs/quote` (ProjectRoom plan + CreditAccount.quote) |
| 6 | Confirm → nodes show real progress; keyframes finish first, then dependent videos start | Node states | `POST /api/runs` → holds → GenerateWorkflow per item → `job.progress` / `node.version` over WS |
| 7 | Success settles credits (balance updates live); a forced failure refunds and shows “Refunded N credits” with Retry | Node, toast, credits | settle / release, `credits.changed` |
| 8 | Change an upstream prompt → downstream shows “Input changed”; run node again → new version; switch active version | Version switcher | input digests, addVersion, active version |
| 9 | Canvas agent panel: “make shot 2 warmer” → graph-patch proposal with diff highlight → Apply produces exactly the shown patch; Discard drops it | Agent panel | `propose.graphPatch`, apply as the user |
| 10 | Open the editor: assembled cut from the script; agent “cut to 10s” proposal → Apply; trim a clip | Editor | timeline EDL + TimelineOps |
| 11 | Export MP4 (progress, result link) | Export dialog | ExportWorkflow + FFmpeg container |
| 12 | Share → read-only link opens in a signed-out browser, no mature outputs, downloads per toggle | Share dialog, share page | share snapshot |
| 13 | Non-member: steps 1, 6 and 9 open the join paywall and resume after checkout | Paywall | `NO_PLAN` |
| 14 | Activity lists every run with cost and refunds | Activity | runs/jobs index |

Test accounts on staging sign in with email codes read from the staging test inbox (`EMAIL_PROVIDER=test-inbox`, admin token protected, disabled in production).
