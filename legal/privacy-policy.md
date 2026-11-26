<!-- Product name: "Rolling" is a working name. Replace every occurrence when the name is final. -->
<!-- Internal: pending review by counsel. Owner-only facts still to add (company legal name, registered address, registration number, country of establishment, EU/UK representative, DPO, lead supervisory authority, transfer mechanism references) are tracked outside this file; do not add bracket placeholders to the served text. -->
<!-- Retention values quote packages/core/src/privacy.ts; change both together. -->

# Privacy policy

Effective date: 26 November 2026
Last updated: 26 November 2026

This policy explains what personal data Rolling collects, why, who we share it with, how long we keep it and what rights you have. Rolling is an online studio for making images and videos with AI models, available at https://rolling.actor.

## Who we are

Rolling ("we", "us") runs the service at https://rolling.actor and is the controller of the personal data described in this policy.

- Privacy and data requests: privacy@rolling.actor
- Legal notices: legal@rolling.actor
- General support: support@rolling.actor

When a team workspace owner invites you, the owner decides what work happens in that workspace. We still process your account data as the controller under this policy.

## Summary

| Data category | Examples | Why we use it | Legal basis | How long we keep it |
|---|---|---|---|---|
| Account | Email address, name, handle, bio, avatar, preferences | Create your account, sign you in, show your profile, send service email | Contract | Until you delete your account |
| Google sign-in | Name, email address, profile picture, Google account ID | Create your account and sign you in (see [Google user data](#google-user-data)) | Contract | Until you delete your account or disconnect Google |
| Sessions | Session record, IP address, browser user agent | Keep you signed in, secure your account | Contract; legitimate interests (security) | 30 days after last use; ends when you sign out |
| Content | Prompts, uploads, generated media, projects, agent conversations, exports | Generate and store your work, run the agent | Contract | Until you delete it, its project or your account |
| Payments and credits | Stripe customer and subscription IDs, plan, seats, credit ledger | Take payments, grant and track credits, refund failed runs | Contract; legal obligation (tax and accounting) | As long as tax and accounting law requires |
| Usage | Runs, costs, agent usage, product metrics, logs | Show Activity, apply the agent allowance, keep the service reliable | Contract; legitimate interests | Agent usage 400 days; metrics about 3 months; logs up to 30 days |
| Safety review | Check results, reason codes, a short text excerpt | Keep illegal and harmful content off the service | Legitimate interests; legal obligation | 365 days (excerpts cleared after 90 days) |
| Feedback | Messages you send through Help, optional diagnostics | Answer you and fix problems | Legitimate interests | Until resolved, then deleted or anonymized |

The sections below give the details.

## Data we collect

### Account data

- **Email address.** You sign in with an emailed one-time code or with Google. We use your email to sign you in, send sign-in and confirmation codes, team invites and service messages.
- **Name and profile.** Your name, and if you set them, a public handle, a short bio and an avatar image.
- **Google sign-in data.** If you sign in with Google, we receive your name, email address, profile picture and Google account ID. See [Google user data](#google-user-data).
- **Session data.** When you sign in we create a session record with the IP address and browser user agent of the request.
- **Preferences.** Language, currency, theme, creation mode, default aspect ratio and model, the "confirm before running" threshold, notification choices and the mature content preference.
- **Workspace and team data.** Workspaces you own or belong to, your role, monthly credit limits set by an owner, and the email addresses of people you invite.

### Content you create

- **Prompts and settings** you type into the prompt box, tools, canvas nodes and the editor.
- **Uploads**: images, videos and audio you upload as references or assets.
- **Generated media**: images, videos and audio the models produce for you, plus thumbnails, poster frames and audio waveforms we derive from them.
- **Projects**: canvases, nodes, timelines, versions, templates, characters and voices you save.
- **Agent conversations**: the messages you send to the agent, its replies, and the plans and edits it proposes.
- **Exports**: video files you render from the editor.
- **Share links**: a snapshot of the project you choose to share and its settings.

### Payment data

Payments are processed by Stripe. Card details are entered on Stripe's pages and go straight to Stripe. **We do not receive or store your card number.** We keep the Stripe customer and subscription identifiers, your plan, billing period, seat count, and a ledger of credits granted, purchased, held, spent and refunded.

### Usage data

- **Activity**: every run, its model, status, cost in credits and any refund.
- **Agent usage**: per agent turn, the model used, tokens and the cost in US dollars, used for the monthly agent allowance.
- **Product metrics** in Cloudflare Analytics Engine: job latency and failures per model, refund rates, agent tokens per turn, proposal acceptance and safety check counts. These events carry workspace identifiers but not your prompts or media.
- **Operational logs**: server logs of requests and errors. They can include your user and workspace identifiers, request paths, IP address and user agent.
- **Feedback**: messages you send through Help. If you leave "include diagnostics" on, we also store your browser user agent, country and Cloudflare data center, workspace, role, plan and language.

### Safety review data

We run automated safety checks on prompts, agent briefs and proposals, uploads and generated outputs (see the [Acceptable use policy](/acceptable-use)). When a check blocks something, or a check fails to run, we log:

- your workspace and user identifiers, and the run and job identifiers;
- the stage (quote, before generation, after generation, upload or agent), the result and the reason codes;
- the classifier model used;
- an **excerpt of up to 200 characters** of the prompt or text that was checked.

We do not store the blocked media in this log. Blocked outputs are deleted. Each upload and output also gets a content rating (safe, suggestive or explicit) stored with it. We cache the results of automated checks for 30 days, keyed by a fingerprint of the content, so the same content is not checked twice.

### Data stored on your device

See [Cookies and local storage](#cookies-and-local-storage).

## Google user data

This section describes what Rolling does with information it receives from Google when you choose **Continue with Google** or Google's One Tap prompt. It applies in addition to the rest of this policy.

### What we access

Rolling uses Google Sign-In only. It requests the scopes `openid`, `email` and `profile`, and receives:

- your **name**;
- your **email address**, and whether Google has verified it;
- your **profile picture** (a link to the image);
- your **Google account ID**, the identifier Google uses for your account.

We do not request access to Gmail, Google Drive, Contacts, Calendar, YouTube or any other Google service or data. We never receive your Google password.

### How we use it

We use Google user data **only to create your Rolling account and sign you in**:

- the Google account ID and verified email address identify your account each time you sign in, and link Google sign-in to an existing Rolling account with the same email;
- your name and profile picture fill in your Rolling profile, where you and members of your workspaces see them. You can change them in Settings at any time.

We use the access token Google gives us once, at sign-in, to confirm your identity with Google. We do not store Google access tokens or refresh tokens, and we do not call Google APIs on your behalf after you have signed in.

### What we do not do

- We **do not sell** Google user data.
- We **do not use** Google user data **for advertising**, including personalized, retargeted or interest-based ads.
- We **do not use** Google user data **to train AI or machine-learning models**, ours or anyone else's.
- We do not share Google user data with third parties, except with the service providers that host Rolling (Cloudflare, see [Subprocessors](/subprocessors)) to store it for the purposes above, when the law requires it, or as part of a merger or acquisition with notice to you.
- No person at Rolling reads your Google user data, except with your permission, for security purposes such as investigating abuse, or to comply with the law.

### Storage and retention

Google user data is stored in our account database on Cloudflare, encrypted in transit (HTTPS) and at rest. We keep it for as long as your account exists. If you disconnect Google in **Settings → Account → Sign-in methods**, we delete the link to your Google account ID. When you delete your account, we delete your name, email address, profile picture and Google account ID along with the rest of your account (see [When you delete your account](#when-you-delete-your-account)); database backups that may still contain them expire within 30 days.

### How to delete it

- Delete your account in **Settings → Account → Delete account**, or
- email **privacy@rolling.actor** from the address on your account and ask us to delete your Google user data or your account.

You can also remove Rolling's access at any time in your Google Account at https://myaccount.google.com/permissions.

### Google API Services User Data Policy

Rolling's use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## How we use data and our legal bases

If you are in the EEA, UK or Switzerland, we rely on these legal bases under the GDPR:

| Purpose | Data | Legal basis |
|---|---|---|
| Create and run your account, sign you in, keep you signed in | Account, Google sign-in, session | Contract |
| Generate images, video and audio; run the agent; store and show your projects | Content, preferences | Contract |
| Take payments, grant and track credits, refund failed runs, issue invoices | Payment, usage | Contract; legal obligation (tax and accounting records) |
| Team workspaces: invites, roles, seats, member limits | Workspace and team data | Contract (with the workspace owner and with you) |
| Send sign-in codes, invites, receipts and service messages | Email | Contract |
| Safety checks, preventing illegal content and abuse, reviewing flagged workspaces | Content, safety review data | Legitimate interests (keeping the service lawful and safe); legal obligation where the law requires it |
| Security, fraud and abuse prevention, rate limits | Session, logs | Legitimate interests |
| Fixing errors and improving reliability and cost | Logs, product metrics, feedback | Legitimate interests |
| Showing mature content only to people who opted in | Preferences, plan | Contract; your choice to opt in |
| Complying with law and legal requests | Any relevant data | Legal obligation |

We do not use your prompts, uploads or outputs to train our own models. We do not sell your personal data. Model vendors process your requests under their own terms (see "Hyperouter and the model vendors behind it" below).

## Who we share data with

We share data only with service providers who help us run Rolling, and as described here. The full list is in our [Subprocessors](/subprocessors) page.

### Cloudflare

Rolling runs on Cloudflare: the app and API, databases, media storage, image processing, background jobs, video rendering containers, logs, product metrics and email. Cloudflare processes all data types listed above.

### Hyperouter and the model vendors behind it

We send generation and agent requests to **Hyperouter**, a model gateway, which routes them to the model vendor that runs the chosen model. To generate an output, a request contains your **prompt, settings (such as length, resolution and aspect ratio), and links to your reference images, videos or audio**. For agent turns, a request contains the conversation, your brief and the parts of your project the agent needs. Safety checks send the text being checked and, for some checks, reference images. We never send your Google user data to Hyperouter or to model vendors.

Depending on the model you or Auto choose, the request is processed by one of these vendors:

| Vendor | Models | Used for |
|---|---|---|
| ByteDance | Seedance, Seedream | Video, images |
| MiniMax | MiniMax H3 | Video, avatar |
| Alibaba (Wan, Qwen) | Wan, Qwen Image | Video, images |
| Lumina | Wan 3.0 (Berry), mature-content models, face detection | Video, images, safety |
| xAI | Grok, Grok Imagine | Agent, images, video |
| Anthropic | Claude | Agent, safety checks |
| OpenAI | GPT | Agent, safety checks |
| DeepSeek | DeepSeek | Agent (default), Auto model choice, safety checks |
| Zhipu | GLM | Agent |

The list of available models changes over time.
<!-- Owner to confirm: Hyperouter's role (processor or independent provider), its data retention, and whether each vendor's terms allow training on inputs. -->

### Stripe

Stripe processes payments, subscriptions and invoices. We send Stripe your email and workspace identifier. Stripe collects your card details directly.
<!-- Owner to confirm: whether Stripe Tax is used. -->

### Email delivery

We send email (sign-in codes, invites, receipts) through Cloudflare Email Service. It receives your email address and the message content to deliver it; we have turned off message previews, so message content is not kept in Cloudflare's activity log. If Cloudflare Email Service is unavailable we may send through Resend instead.
<!-- Owner to confirm: remove the Resend sentence if the backup is not enabled. -->

### Google sign-in

If you sign in with Google, Google confirms your identity to us. Google's own privacy policy applies to what it collects. See [Google user data](#google-user-data) for what we receive and how we use it.

### Error monitoring

We may add an error monitoring service. If we do, it will receive error reports that may include user and workspace identifiers, request paths and browser details, and we will list it on the [Subprocessors](/subprocessors) page first.
<!-- Sentry is planned, not active. -->

### Other people you choose to share with

- **Team members** in your workspace can see its projects, assets, Activity and credit use, according to their role.
- **Share links** let anyone with the link (or only workspace members, if you choose) view a read-only snapshot of a project. Downloads are off unless you turn them on. Prompts are left out if you turn off "show prompt".
- **Public profile**: your name, handle, bio, avatar and the covers of share links you publish to your profile are public.

Mature (suggestive or explicit) media never appears on share links, profiles, templates or the public library.

### Legal and safety disclosures

We may disclose data when the law requires it, to respond to valid legal requests, to report child sexual abuse material to the competent authorities as required (such as the National Center for Missing & Exploited Children in the United States), or to protect people from harm.

### Business transfers

If we are involved in a merger, acquisition or sale of assets, data may transfer to the new owner under this policy. We will tell you before your data becomes subject to a different privacy policy.

## International transfers

Our providers process data in several countries:

- **Cloudflare** runs a global network. Data may be processed in the data center closest to you and stored in Cloudflare's data centers.
- **Model vendors may process your prompts and media in China and the United States**, and in other countries where they operate. ByteDance, MiniMax, Alibaba, Lumina, DeepSeek and Zhipu may process data in China. Anthropic, OpenAI and xAI process data in the United States. Some DeepSeek models are served from US hosting; Rolling picks the cheaper route automatically, so a DeepSeek request may be processed in either China or the United States.
- **Stripe** processes data in the United States and other countries.

Where we transfer personal data from the EEA, UK or Switzerland to a country without an adequacy decision, we use the European Commission's Standard Contractual Clauses, the UK International Data Transfer Addendum or another lawful mechanism. You can ask for a copy of the safeguards at privacy@rolling.actor.
<!-- Owner to confirm: D1 and R2 location hints or jurisdiction; SCC modules; IDTA reference; transfer impact assessment for China; Lumina processing location. -->

## How long we keep data

| Data | How long |
|---|---|
| Account (email, name, profile, preferences) | Until you delete your account |
| Google sign-in data (name, email, profile picture, Google account ID) | Until you delete your account or disconnect Google |
| Session | 30 days after it was last refreshed (refreshed once a day while you use Rolling); ends when you sign out |
| Sign-in and email-change codes | 10 minutes, 5 tries, stored only as a hash |
| Account deletion confirmation code | 10 minutes |
| Projects, assets, uploads, generated media, exports, agent conversations | Until you delete them, their project or your account |
| Unfinished uploads | Aborted and removed after 7 days |
| Share links | Until you turn the link off, delete the project or delete your account |
| Safety review log | 365 days; the text excerpt is cleared after 90 days. Kept after account deletion, with your user identifier replaced by a pseudonym, so we can enforce our policies and meet legal duties |
| Cached safety check results | 30 days |
| Credit ledger, invoices and billing records | As long as tax and accounting law requires. When you delete your account, your user identifier in the ledger is replaced by a pseudonym: a one-way code that does not identify you |
| Agent usage records | 400 days. Your user identifier is replaced by a pseudonym when you delete your account |
| Data exports you request | 7 days, then the file is deleted |
| Feedback | Until it is resolved. Your user identifier is removed when you delete your account |
| Operational logs | Up to 30 days |
| Product metrics | About 3 months |
| Database backups | Up to 30 days |

Model vendors and Hyperouter may keep request data under their own terms. Output links from Hyperouter expire (images after 24 hours, videos after 15 minutes); we copy outputs to our storage straight away.

### When you delete your account

You can delete your account in **Settings → Account → Delete account**. We email you a code to confirm. Then:

- Every workspace you own alone is closed. Its subscription is set to cancel at the end of the billing period. Its projects, assets, uploads, characters, voices, templates, agent threads, exports and share links are deleted, and its stored media files are deleted in the background, usually within minutes.
- If you own a team workspace that still has other members, you must make someone else an owner first.
- You leave workspaces you share with others. Projects, assets, share links and templates you made there stay with that workspace, but your name is removed from them (in project history it is replaced by a pseudonym), and your share links leave your profile. Your agent conversations there are deleted.
- Your preferences and avatar are deleted, then your account, linked Google sign-in data and all sessions.
- Purchased credits in deleted workspaces are lost and are not refunded.
- We keep what we must: the safety review log (for the period above), billing and ledger records and agent usage records, each with your user identifier replaced by a pseudonym, and a closed workspace record for billing history.

Your account, sessions and the records listed above are removed or pseudonymized at once. Project working copies, agent conversations and stored media are removed by a background job, usually within minutes and always within 30 days. Copies in database backups expire with the backups (see the table above).

## Your rights

Depending on where you live, you have the right to:

- **Access** the personal data we hold about you.
- **Correct** it. You can change your name, handle, bio, avatar and email in Settings.
- **Delete** it. You can delete your account in Settings, or ask us.
- **Export** it. In **Settings → Account → Export my data** you can ask for a copy of your data: your profile and preferences, workspaces, projects (canvas and timeline), a list of your assets with download links, agent conversations, generation history and credit ledger, in one ZIP file of JSON files. We email you a download link that works for 7 days. You can ask once every 24 hours. You can also download your generated media and exports at any time, or ask us at privacy@rolling.actor.
- **Object** to processing based on legitimate interests, and to direct marketing.
- **Restrict** processing in some cases.
- **Withdraw consent** where we rely on it, for example by turning off the mature content preference.
- **Complain** to a data protection authority, such as the authority in the country where you live or work.

Email privacy@rolling.actor to make a request. We may ask you to confirm your identity, usually by replying from the email on your account. We answer within one month (GDPR) or 45 days (CCPA), and tell you if we need longer.

If you are a member of a team workspace, some content belongs to that workspace. We may refer requests about workspace content to its owner.

## Children and age limits

Rolling is not for children. You must be at least 13 years old, or older if the law where you live sets a higher age to use online services without a parent's consent, and old enough to agree to our [Terms of service](/terms).

Mature (18+) content is only for adults. It is available only to workspaces with an active paid plan and only to users who turn on the mature content preference. We treat paying for a plan as the age gate and do not check your date of birth.

If you believe a child has given us personal data, email privacy@rolling.actor and we will delete it.
<!-- Owner to confirm: minimum age; regional age-assurance requirements (UK, some US states). -->

## Cookies and local storage

We do not use advertising or third-party tracking cookies.

### Cookies

| Name | Purpose | Lifetime |
|---|---|---|
| `__Secure-rolling.session_token` | Keeps you signed in. HTTP-only, secure, same-site | 30 days, refreshed while you use Rolling |
| Short-lived sign-in cookies | Protect Google sign-in against forgery | Minutes, for the sign-in only |

These cookies are strictly necessary, so we do not ask for consent to them.

### Local storage in your browser

Rolling stores some data in your browser so the app works and feels fast. It stays on your device and is not sent to us unless noted.

- **localStorage**: your preferences cache, language, creation mode, the active workspace, the agent model you picked, the agent thread you were using on a screen, and whether you have seen the intro screen.
- **sessionStorage**: an action a payment screen interrupted, such as your brief, so it can continue after checkout. It is cleared when you close the tab.
- **IndexedDB**: a cache of the model catalog; the upload and download queue (`rolling-transfers`), including a copy of files up to 500 MB so uploads can resume after a reload. The copy is removed when the upload finishes or is canceled.
- **Origin private file system (OPFS)** or IndexedDB: downloaded files and media cached for previews and the editor, up to 1 GB, removed oldest first.
- **Service worker cache**: the app's own files, so Rolling starts fast and opens offline. It never holds your account data or API responses.

You can clear all of this in your browser settings. Rolling will still work, but uploads in progress will not resume.

## Security

We use HTTPS everywhere, HTTP-only secure session cookies, hashed sign-in codes, and access checks on every request. Private media is never public: it is served through short-lived signed links, only to people allowed to see it. Payment webhooks and model gateway webhooks are signed and verified. Rate limits protect sign-in and other sensitive routes.

No system is perfectly secure. If we learn of a breach that affects your personal data, we will tell you and the authorities as the law requires.

## California privacy rights

This section applies to California residents under the California Consumer Privacy Act as amended by the CPRA (CCPA).

**Categories we collect** (in the last 12 months): identifiers (email, name, account and session identifiers, Google account ID, IP address); customer records (billing identifiers; card data is held by Stripe); commercial information (plans, credit purchases, runs); internet activity (usage within Rolling, logs); audio and visual information (uploads and generated media); inferences are not created for profiling. Sensitive personal information: account login (email with a one-time code, or Google sign-in). We do not use sensitive personal information to infer characteristics about you.

**Sources**: you, your browser, Google (if you sign in with it), Stripe and workspace owners who invite you.

**Purposes**: the purposes in [How we use data](#how-we-use-data-and-our-legal-bases).

**Disclosure for a business purpose**: to the service providers in [Who we share data with](#who-we-share-data-with).

**We do not sell or share personal data** as "sell" and "share" are defined by the CCPA. We do not use personal data for cross-context behavioral advertising. We have no actual knowledge of selling or sharing data of consumers under 16.

**Your rights**: to know, access, correct and delete your personal information, and to not be discriminated against for using these rights. You can use an authorized agent; we may ask for proof of authorization and to verify your identity. Email privacy@rolling.actor.

**Retention**: see [How long we keep data](#how-long-we-keep-data).

## Changes to this policy

We will post changes on this page and update the date at the top. If a change is material, we will tell you by email or in the app before it takes effect.

## Contact

Rolling
Privacy: privacy@rolling.actor
Support: support@rolling.actor
