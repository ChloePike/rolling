<!-- Product name: "Rolling" is a working name. Replace every occurrence when the name is final. Bracketed ALL-CAPS text is a placeholder for the owner. -->

# Privacy policy

> **Draft for legal review — not yet in effect.**

Effective date: [EFFECTIVE DATE]
Last updated: [LAST UPDATED DATE]

This policy explains what personal data Rolling collects, why, who we share it with, how long we keep it and what rights you have. Rolling is an online studio for making images and videos with AI models, available at https://rolling.actor.

## Who we are

Rolling is operated by [COMPANY LEGAL NAME], [REGISTERED ADDRESS], company number [COMPANY REGISTRATION NUMBER] ("we", "us"). We are the controller of the personal data described in this policy.

- Privacy and data requests: privacy@rolling.actor
- Legal notices: legal@rolling.actor
- General support: support@rolling.actor
- EU representative: [EU REPRESENTATIVE NAME AND ADDRESS, if required]
- UK representative: [UK REPRESENTATIVE NAME AND ADDRESS, if required]
- Data protection officer: [DPO CONTACT, if appointed]

When a team workspace owner invites you, the owner decides what work happens in that workspace. We still process your account data as the controller under this policy.

## Data we collect

### Account data

- **Email address.** You sign in with an emailed one-time code or with Google. We use your email to sign you in, send sign-in and confirmation codes, team invites and service messages.
- **Name and profile.** Your name, and if you set them, a public handle, a short bio and an avatar image.
- **Google sign-in data.** If you sign in with Google, Google sends us a signed token with your email, name, profile picture and Google account identifier. We keep the identifier to link the sign-in to your account. We do not receive your Google password.
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

## How we use data and our legal bases

If you are in the EEA, UK or Switzerland, we rely on these legal bases under the GDPR:

| Purpose | Data | Legal basis |
|---|---|---|
| Create and run your account, sign you in, keep you signed in | Account, session | Contract |
| Generate images, video and audio; run the agent; store and show your projects | Content, preferences | Contract |
| Take payments, grant and track credits, refund failed runs, issue invoices | Payment, usage | Contract; legal obligation (tax and accounting records) |
| Team workspaces: invites, roles, seats, member limits | Workspace and team data | Contract (with the workspace owner and with you) |
| Send sign-in codes, invites, receipts and service messages | Email | Contract |
| Safety checks, preventing illegal content and abuse, reviewing flagged workspaces | Content, safety review data | Legitimate interests (keeping the service lawful and safe); legal obligation where the law requires it |
| Security, fraud and abuse prevention, rate limits | Session, logs | Legitimate interests |
| Fixing errors and improving reliability and cost | Logs, product metrics, feedback | Legitimate interests |
| Showing mature content only to people who opted in | Preferences, plan | Contract; your choice to opt in |
| Complying with law and legal requests | Any relevant data | Legal obligation |

We do not use your prompts, uploads or outputs to train our own models. We do not sell your personal data. [CONFIRM: whether any model vendor may use inputs to train its models under its terms; see "Model vendors" below.]

## Who we share data with

We share data only with service providers who help us run Rolling, and as described here. The full list is in our [Subprocessors](/subprocessors) page.

### Cloudflare

Rolling runs on Cloudflare: the app and API, databases, media storage, image processing, background jobs, video rendering containers, logs, product metrics and email. Cloudflare processes all data types listed above.

### Hyperouter and the model vendors behind it

We send generation and agent requests to **Hyperouter**, a model gateway, which routes them to the model vendor that runs the chosen model. To generate an output, a request contains your **prompt, settings (such as length, resolution and aspect ratio), and links to your reference images, videos or audio**. For agent turns, a request contains the conversation, your brief and the parts of your project the agent needs. Safety checks send the text being checked and, for some checks, reference images.

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

The list of available models changes over time. [CONFIRM: Hyperouter's role (processor or independent provider), its data retention, and whether each vendor's terms allow training on inputs.]

### Stripe

Stripe processes payments, subscriptions, invoices and tax calculations [CONFIRM: whether Stripe Tax is used]. We send Stripe your email and workspace identifier. Stripe collects your card details directly.

### Email delivery

We send email (sign-in codes, invites, receipts) through [EMAIL PROVIDER: Cloudflare Email Service or Resend]. It receives your email address and the message content.

### Google sign-in

If you sign in with Google, Google confirms your identity to us. Google's own privacy policy applies to what it collects.

### Error monitoring

[CONFIRM: Sentry is planned for error monitoring but is not active yet. When enabled, it receives error reports that may include user and workspace identifiers, request paths and browser details.]

### Other people you choose to share with

- **Team members** in your workspace can see its projects, assets, Activity and credit use, according to their role.
- **Share links** let anyone with the link (or only workspace members, if you choose) view a read-only snapshot of a project. Downloads are off unless you turn them on. Prompts are left out if you turn off "show prompt".
- **Public profile**: your name, handle, bio, avatar and the covers of share links you publish to your profile are public.

Mature (suggestive or explicit) media never appears on share links, profiles, templates or the public library.

### Legal and safety disclosures

We may disclose data when the law requires it, to respond to valid legal requests, to report child sexual abuse material to the authorities as required (for example [NCMEC OR RELEVANT AUTHORITY]), or to protect people from harm.

### Business transfers

If we are involved in a merger, acquisition or sale of assets, data may transfer to the new owner under this policy.

## International transfers

We are based in [COUNTRY OF ESTABLISHMENT]. Our providers process data in several countries:

- **Cloudflare** runs a global network. Data may be processed in the country closest to you and stored in [CONFIRM: D1 and R2 location hints or jurisdiction].
- **Model vendors may process your prompts and media in China and the United States**, and in other countries where they operate. ByteDance, MiniMax, Alibaba, Lumina [CONFIRM], DeepSeek and Zhipu may process data in China. Anthropic, OpenAI and xAI process data in the United States. Some DeepSeek models are served from US hosting; Rolling picks the cheaper route automatically, so a DeepSeek request may be processed in either China or the United States.
- **Stripe** processes data in the United States and other countries.

Where we transfer personal data from the EEA, UK or Switzerland to a country without an adequacy decision, we use the European Commission's Standard Contractual Clauses [SCC MODULES AND REFERENCE], the UK International Data Transfer Addendum [IDTA REFERENCE] or another lawful mechanism. [CONFIRM: transfer impact assessment for China.] You can ask for a copy of the safeguards at privacy@rolling.actor.

## How long we keep data

| Data | How long |
|---|---|
| Account (email, name, profile, preferences) | Until you delete your account |
| Session | 30 days after it was last refreshed (refreshed once a day while you use Rolling); ends when you sign out |
| Sign-in and email-change codes | 10 minutes, 5 tries, stored only as a hash |
| Account deletion confirmation code | 10 minutes |
| Projects, assets, uploads, generated media, exports, agent conversations | Until you delete them, their project or your account |
| Unfinished uploads | Aborted and removed after 7 days |
| Share links | Until you turn the link off, delete the project or delete your account |
| Safety review log | [SAFETY LOG RETENTION PERIOD]. Kept after account deletion so we can enforce our policies and meet legal duties |
| Cached safety check results | 30 days |
| Credit ledger, invoices and billing records | [BILLING RECORD RETENTION, e.g. as long as tax law requires]. Your user identifier is removed from the ledger when you delete your account |
| Agent usage records | [AGENT USAGE RETENTION PERIOD] |
| Feedback | [FEEDBACK RETENTION PERIOD]. Your user identifier is removed when you delete your account |
| Operational logs | [LOG RETENTION PERIOD, set in Cloudflare Workers Logs] |
| Product metrics | About 3 months [CONFIRM: Cloudflare Analytics Engine retention] |
| Database backups | Up to 30 days [CONFIRM: Cloudflare D1 point-in-time recovery window] |

Model vendors and Hyperouter may keep request data under their own terms. Output links from Hyperouter expire (images after 24 hours, videos after 15 minutes); we copy outputs to our storage straight away. [CONFIRM: Hyperouter and vendor retention.]

### When you delete your account

You can delete your account in **Settings → Account → Delete account**. We email you a code to confirm. Then:

- Every workspace you own alone is closed. Its subscription is set to cancel at the end of the billing period. Its projects, assets, uploads, characters, voices, templates, agent threads and share links are deleted, and its stored media files are deleted in the background, usually within minutes.
- If you own a team workspace that still has other members, you must make someone else an owner first.
- You leave workspaces you share with others. Assets, share links and templates you made there stay with that workspace, but your name is removed from them, and your share links leave your profile.
- Your preferences and avatar are deleted, then your account, linked Google sign-in and all sessions.
- Purchased credits in deleted workspaces are lost and are not refunded.
- We keep what we must: the safety review log, billing and ledger records (without your user identifier) and a closed workspace record for billing history.

Project working copies and agent conversations of closed workspaces are removed within [DELETION TIMEFRAME FOR PROJECT AND AGENT STORAGE].

## Your rights

Depending on where you live, you have the right to:

- **Access** the personal data we hold about you.
- **Correct** it. You can change your name, handle, bio, avatar and email in Settings.
- **Delete** it. You can delete your account in Settings, or ask us.
- **Export** it. There is no self-serve export yet; we provide a copy of your data **on request**. You can download your generated media and exports at any time.
- **Object** to processing based on legitimate interests, and to direct marketing.
- **Restrict** processing in some cases.
- **Withdraw consent** where we rely on it, for example by turning off the mature content preference.
- **Complain** to a data protection authority, such as [LEAD SUPERVISORY AUTHORITY] or the authority where you live.

Email privacy@rolling.actor to make a request. We may ask you to confirm your identity, usually by replying from the email on your account. We answer within one month (GDPR) or 45 days (CCPA), and tell you if we need longer.

If you are a member of a team workspace, some content belongs to that workspace. We may refer requests about workspace content to its owner.

## Children and age limits

Rolling is not for children. You must be at least [MINIMUM AGE, e.g. 13 or 16] to use Rolling, and old enough to agree to these terms where you live.

Mature (18+) content is only for adults. It is available only to workspaces with an active paid plan and only to users who turn on the mature content preference. We treat paying for a plan as the age gate and do not check your date of birth. [CONFIRM: regional age-assurance requirements, for example in the UK and some US states.]

If you believe a child has given us personal data, email privacy@rolling.actor and we will delete it.

## Cookies and local storage

We do not use advertising or third-party tracking cookies.

### Cookies

| Name | Purpose | Lifetime |
|---|---|---|
| `__Secure-rolling.session_token` | Keeps you signed in. HTTP-only, secure, same-site | 30 days, refreshed while you use Rolling |
| Short-lived sign-in cookies [CONFIRM: names, if any] | Protect Google sign-in against forgery | Minutes, for the sign-in only |

These cookies are strictly necessary, so we do not ask for consent to them.

### Local storage in your browser

Rolling stores some data in your browser so the app works and feels fast. It stays on your device and is not sent to us unless noted.

- **localStorage**: your preferences cache, language, creation mode, the active workspace, the agent model you picked, the agent thread you were using on a screen, and whether you have seen the intro screen.
- **sessionStorage**: an action a payment screen interrupted, such as your brief, so it can continue after checkout. It is cleared when you close the tab.
- **IndexedDB**: a cache of the model catalog; the upload and download queue (`rolling-transfers`), including a copy of files up to 500 MB so uploads can resume after a reload. The copy is removed when the upload finishes or is canceled.
- **Origin private file system (OPFS)** or IndexedDB: downloaded files and media cached for previews and the editor, up to 1 GB, removed oldest first.

You can clear all of this in your browser settings. Rolling will still work, but uploads in progress will not resume.

## Security

We use HTTPS everywhere, HTTP-only secure session cookies, hashed sign-in codes, and access checks on every request. Private media is never public: it is served through short-lived signed links, only to people allowed to see it. Payment webhooks and model gateway webhooks are signed and verified. Rate limits protect sign-in and other sensitive routes.

No system is perfectly secure. If we learn of a breach that affects your personal data, we will tell you and the authorities as the law requires.

## California privacy rights

This section applies to California residents under the California Consumer Privacy Act as amended by the CPRA (CCPA).

**Categories we collect** (in the last 12 months): identifiers (email, name, account and session identifiers, IP address); customer records (billing identifiers; card data is held by Stripe); commercial information (plans, credit purchases, runs); internet activity (usage within Rolling, logs); audio and visual information (uploads and generated media); inferences are not created for profiling. Sensitive personal information: account login (email with a one-time code). We do not use sensitive personal information to infer characteristics about you.

**Sources**: you, your browser, Google (if you sign in with it), Stripe and workspace owners who invite you.

**Purposes**: the purposes in [How we use data](#how-we-use-data-and-our-legal-bases).

**Disclosure for a business purpose**: to the service providers in [Who we share data with](#who-we-share-data-with).

**We do not sell or share personal data** as "sell" and "share" are defined by the CCPA. We do not use personal data for cross-context behavioral advertising. We have no actual knowledge of selling or sharing data of consumers under 16.

**Your rights**: to know, access, correct and delete your personal information, and to not be discriminated against for using these rights. You can use an authorized agent; we may ask for proof of authorization and to verify your identity. Email privacy@rolling.actor.

**Retention**: see [How long we keep data](#how-long-we-keep-data).

## Changes to this policy

We will post changes on this page and update the date at the top. If a change is material, we will tell you by email or in the app before it takes effect.

## Contact

[COMPANY LEGAL NAME]
[REGISTERED ADDRESS]
privacy@rolling.actor
