<!-- Product name: "Rolling" is a working name. Replace every occurrence when the name is final. Bracketed ALL-CAPS text is a placeholder for the owner. -->

# Subprocessors

> **Draft for legal review — not yet in effect.**

Last updated: [LAST UPDATED DATE]

These are the third parties that process personal data for Rolling. See the [Privacy policy](/privacy) for how we use data and how transfers are protected. We will update this page before we add a new subprocessor. [CONFIRM: notice period and how customers subscribe to updates.]

## Infrastructure and payments

| Name | Purpose | Data | Location |
|---|---|---|---|
| Cloudflare, Inc. | Hosting of the app and API (Workers), databases (D1, Durable Objects), media storage (R2), image processing (Images), background jobs (Workflows, Queues), video rendering (Containers), logs (Workers Logs), product metrics (Analytics Engine), inbound email routing | All data types in the Privacy policy: account, sessions, content, media, usage, safety logs | Global network; storage in [CONFIRM: D1 and R2 location or jurisdiction] |
| [EMAIL PROVIDER: Cloudflare Email Service or Resend] | Sending sign-in codes, invites, receipts and service email | Email address, message content (including one-time codes) | [LOCATION] |
| Stripe, Inc. / [STRIPE CONTRACTING ENTITY] | Payments, subscriptions, invoices, customer portal [CONFIRM: tax] | Email, workspace identifier, plan and seats, payment details collected by Stripe directly | United States and other countries |
| Sentry (Functional Software, Inc.) [CONFIRM: planned, not yet active] | Error monitoring | Error reports, user and workspace identifiers, request paths, browser details | [LOCATION] |

## Model gateway and model vendors

Generation and agent requests go to Hyperouter, which routes each request to the vendor that runs the chosen model. Requests contain prompts, settings, conversation text and links to reference images, videos or audio. Safety checks send the text being checked and, for some checks, images.

| Name | Purpose | Data | Location |
|---|---|---|---|
| Hyperouter [LEGAL ENTITY] | Model gateway for all generation, agent and safety model calls | Prompts, parameters, reference media links, agent conversations, safety check inputs; generated outputs | [LOCATION] |
| ByteDance (Seedance, Seedream) | Video and image generation | Prompts, parameters, reference media | [CONFIRM: China and/or other regions] |
| MiniMax | Video and avatar generation | Prompts, parameters, reference media | [CONFIRM: China and/or other regions] |
| Alibaba Cloud (Wan, Qwen) | Video and image generation | Prompts, parameters, reference media | [CONFIRM: China and/or other regions] |
| Lumina | Video and image generation (including Wan 3.0 via Berry and mature-content models), face detection for safety checks | Prompts, parameters, reference media, uploaded photos checked for faces | [LOCATION] |
| xAI (Grok) | Agent model; image and video generation | Agent conversations; prompts, parameters, reference media | United States |
| Anthropic (Claude) | Agent model; safety checks (fallback) | Agent conversations; text and images being checked | United States |
| OpenAI (GPT) | Agent model; safety checks (fallback) | Agent conversations; text and images being checked | United States |
| DeepSeek | Default agent model; Auto model choice; safety checks | Agent conversations; prompts and references for model choice; text and images being checked | China, or United States for US-hosted variants |
| Zhipu (GLM) | Agent model | Agent conversations | [CONFIRM: China] |

## Google sign-in

Google confirms your identity when you choose to sign in with it. Google acts under its own terms and privacy policy rather than as our subprocessor.
