<!-- Product name: "Rolling" is a working name. Replace every occurrence when the name is final. -->
<!-- Internal: pending review by counsel. Owner-only facts are kept in HTML comments below; do not add bracket placeholders to the served text. -->

# Subprocessors

Last updated: 26 November 2026

These are the third parties that process personal data for Rolling. See the [Privacy policy](/privacy) for how we use data and how transfers are protected. We will update this page before we add a new subprocessor.
<!-- Owner to confirm: notice period and how customers subscribe to updates. -->

## Infrastructure and payments

| Name | Purpose | Data | Location |
|---|---|---|---|
| Cloudflare, Inc. | Hosting of the app and API (Workers), databases (D1, Durable Objects), media storage (R2), image processing (Images), background jobs (Workflows, Queues), video rendering (Containers), logs (Workers Logs), product metrics (Analytics Engine), outgoing email (Email Service: sign-in codes, invites, receipts and service email; message previews are turned off), inbound email routing | All data types in the Privacy policy: account, sessions, content, media, usage, safety logs | Global network |
| Resend, Inc. (backup only; used only if Cloudflare Email Service is unavailable) | Sending sign-in codes, invites, receipts and service email | Email address, message content (including one-time codes) | United States |
| Stripe, Inc. | Payments, subscriptions, invoices, customer portal | Email, workspace identifier, plan and seats, payment details collected by Stripe directly | United States and other countries |

## Model gateway and model vendors

Generation and agent requests go to Hyperouter, which routes each request to the vendor that runs the chosen model. Requests contain prompts, settings, conversation text and links to reference images, videos or audio. Safety checks send the text being checked and, for some checks, images.

| Name | Purpose | Data | Location |
|---|---|---|---|
| Hyperouter | Model gateway for all generation, agent and safety model calls | Prompts, parameters, reference media links, agent conversations, safety check inputs; generated outputs | Not yet confirmed |
| ByteDance (Seedance, Seedream) | Video and image generation | Prompts, parameters, reference media | China and other regions |
| MiniMax | Video and avatar generation | Prompts, parameters, reference media | China and other regions |
| Alibaba Cloud (Wan, Qwen) | Video and image generation | Prompts, parameters, reference media | China and other regions |
| Lumina | Video and image generation (including Wan 3.0 via Berry and mature-content models), face detection for safety checks | Prompts, parameters, reference media, uploaded photos checked for faces | Not yet confirmed |
| xAI (Grok) | Agent model; image and video generation | Agent conversations; prompts, parameters, reference media | United States |
| Anthropic (Claude) | Agent model; safety checks (fallback) | Agent conversations; text and images being checked | United States |
| OpenAI (GPT) | Agent model; safety checks (fallback) | Agent conversations; text and images being checked | United States |
| DeepSeek | Default agent model; Auto model choice; safety checks | Agent conversations; prompts and references for model choice; text and images being checked | China, or United States for US-hosted variants |
| Zhipu (GLM) | Agent model | Agent conversations | China |

## Google sign-in

Google confirms your identity when you choose to sign in with it. Google acts under its own terms and privacy policy rather than as our subprocessor. It receives no data from us; we receive your name, email address, profile picture and Google account ID from it (see [Google user data](/privacy#google-user-data)).
