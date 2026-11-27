# Trust & safety operations

How staff review content, handle reports, appeals and copyright notices, and escalate child sexual abuse material (CSAM). Decisions: D-025 (console, staff, audit, suspensions), D-026 (queue, reports), D-027 (child safety), D-028 (appeals, DMCA). Code: `apps/api/src/ops/*`, `apps/api/src/routes/{admin,trust}.ts`, `packages/core/src/ops/*`, `apps/web/src/features/{admin,trust}`.

## Access

- The console is `/admin`. Only people in the `staff` table can open it; the server checks every call (signed out 401, not staff 404, missing permission 403).
- Roles: **admin** (everything, including credits, plans, operations, staff and child-safety cases) and **reviewer** (accounts, the review queue, warnings, suspensions, content removal, DMCA, appeals).
- Add or remove staff from the console API (`POST /api/admin/staff`, `DELETE /api/admin/staff/:email`, admin only). The owner is seeded as admin.
- Every action needs a written reason and lands in the append-only audit log (`/admin/audit`). Nothing in the log can be changed or deleted.

## The queue

`/admin/queue` lists open cases, most urgent first:

| Priority | What |
|---|---|
| Urgent | Child-safety cases (admins only); child-safety reports |
| High | Workspaces flagged by repeated hard-limit blocks (SAFETY_REVIEW); reports of real-person sexual content, non-consensual content, violence, extremism, self-harm; appeals of suspensions; counter-notices |
| Normal | Other reports, DMCA notices, appeals of blocked runs, single hard-limit events |

Targets: first response to urgent cases within 24 hours, others within 3 business days (owner to confirm and publish in the AUP).

### Safety cases (hard-limit events)

One open case per workspace collects its blocked requests (stage, codes, a 200-character excerpt for 90 days). Review the pattern:

- **Dismiss** when the blocks were false positives or one-offs. This clears the review flag, so mature runs resume.
- **Warn** for a first, low-severity violation. The user sees the notice in the app.
- **Suspend** the user or the workspace for repeated or deliberate violations, or attempts to get around the checks.
- **Escalate as child safety** if anything suggests CSAM (see below).

### Reports

Reports come from the Report link on share pages and profiles and from the abuse form at `/report`. Open the content from the case, then:

- **Delete content** removes the share link, its snapshot and its media (or a profile's published works and bio) and notifies the owner.
- **Warn** or **suspend** the owner as above.
- **Dismiss** when nothing breaks the policy.
- Child-safety reports cannot be removed directly: **escalate** first, so the evidence is preserved before the content goes.

### Appeals

A suspended user appeals from the banner; a blocked run is appealed from its message in Activity. **Overturn** lifts the suspension and clears the review flag; **uphold** keeps it. The user sees the outcome either way.

## Copyright (DMCA)

1. A notice arrives through `/dmca` with the § 512(c)(3) elements (the form refuses incomplete notices). Check that the work and the Rolling link are identified and that the sender is plausibly the rights holder or their agent.
2. **Take down** disables the named share links (the content is kept so it can be restored) and tells the owner, with the case reference for a counter-notice.
3. A counter-notice (`/counter-notice`, the owner only) lands as its own case. **Forward** it to the complainant by email (outside the app for now) and record it; the restore date is 10 business days later.
4. After that date, **restore** unless the complainant has told us they filed a court action (then dismiss the counter-notice and keep the content down).
5. Repeat infringers: suspend accounts with repeated valid notices (policy and the registered DMCA agent are owner items; `legal/acceptable-use-policy.md`).

## Child sexual abuse material (CSAM)

US law (18 U.S.C. § 2258A) requires us to report apparent CSAM we become aware of to the NCMEC CyberTipline and to preserve it for one year after the report. Never view more than needed, never copy it elsewhere, never forward it by email or chat.

### What the system does automatically

When a check blocks with `MINOR_SEXUAL` (any stage), or a reviewer escalates a report or safety case:

1. **Preserves the evidence first.** The media the check looked at (blocked outputs, references, the upload, a reported share snapshot and its media) and the full checked text are copied into the private R2 prefix `evidence/<caseId>/` with SHA-256 hashes, before the output is deleted or the share removed. `evidence_items` records each file. The database refuses to delete these records until the case is closed and 365 days have passed; the R2 bucket lock rule on `evidence/` keeps the objects for the same period.
2. **Flags the account** when media was involved: the workspace's mature runs pause and the user and the workspace are suspended pending review. A text-only hit opens the urgent case without restricting the account; the reviewer decides.
3. **Opens an urgent, restricted case** (admins only) with a prefilled CyberTipline report packet.

Nothing is sent to NCMEC automatically. Nothing deletes the evidence automatically.

### What the reviewer does

1. Open the case in `/admin/queue` (admins only). The console shows the evidence manifest (ids, types, sizes, hashes) and the packet, never the files or the prompt.
2. Decide whether the content is apparent CSAM. If the evidence must be examined, a designated custodian views it in the Cloudflare dashboard (R2 → `rolling-media-<env>` → `evidence/<caseId>/`) with an account that has access to the bucket, and records that they did in the case reason. Do not download it to a personal device.
3. If it is apparent CSAM, submit a CyberTipline report at https://report.cybertip.org/ (ESP reporting) using the packet: incident time, detection, reported user (id, email, workspace), files with hashes. Fill in the bracketed reporter fields (company legal name, ESP id, contact). Attach files only from the evidence prefix, only if the report form requires them.
4. Record the CyberTipline report number with **Record the CyberTipline report** (`mark_submitted`).
5. Keep the account suspended; remove any public content (**Delete content**); close the case. The evidence stays for its retention period.
6. If it is not CSAM (for example a classifier false positive on text), record why, lift the suspension from the user page, and close. Evidence still follows its retention; only the owner can approve earlier deletion with counsel.
7. Law-enforcement requests for preserved material go to the owner and counsel; preservation may be extended on request (2258A(h)).

### Access and retention

- `evidence/` and `backups/` are never served by any media route, signed or not.
- Access to the bucket in the Cloudflare dashboard is limited to the owner and the designated custodian (Cloudflare account members with R2 access); review that list quarterly.
- Retention: 365 days after the report, longer on a law-enforcement request. Deleting after retention needs the case closed; delete the R2 objects (after the lock period) and then the `evidence_items` rows.

## Setup the owner needs to do

- R2 bucket lock rule on `evidence/` (365 days) and lifecycle rule on `backups/` (30 days) for each environment: `docs/deploy.md`.
- NCMEC ESP registration (company legal name, ESP id, contact) and the packet placeholders in `packages/core/src/ops/ncmec.ts`.
- DMCA agent registration with the US Copyright Office, and the agent details in the AUP.
- Response times for reports and appeals, published in the AUP.
