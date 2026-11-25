/**
 * M0.5 model spike (Node, run with tsx):
 *
 *   pnpm --dir packages/core exec tsx ../../scripts/spike/run.ts [--no-paid] [--no-chat]
 *
 * 1. GET /v1/models, build the catalog (listing + overlay) and report overlay ids, prices and credits.
 * 2. One image (Seedream 5.0 Lite, async) and one 5 s video (Seedance 2.0 Mini,
 *    480p), polled to completion: cost, latency, output URLs.
 * 3. One streamed chat call to DeepSeek with one tool (`pricing.estimate`).
 *
 * Writes scripts/spike/RESULTS.md (generated part). Spend: exactly one image and one video.
 * HYPEROUTER_API_KEY may be a placeholder when a proxy injects the credential.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from '../../packages/core/src/ids';
import { estimateUsd } from '../../packages/core/src/models/capabilities';
import { Catalog } from '../../packages/core/src/models/catalog';
import { MODEL_OVERLAY } from '../../packages/core/src/models/overlay';
import { pollUntilDone } from '../../packages/core/src/models/poll';
import {
  HyperouterClient,
  HyperouterError,
  HyperouterLlmProvider,
  createHyperouterGenerationProvider,
} from '../../packages/core/src/models/providers/hyperouter';
import type { ChatEvent, JobStatus } from '../../packages/core/src/models/types';
import { creditsFor } from '../../packages/core/src/pricing/config';

const args = new Set(process.argv.slice(2));
const RUN_PAID = !args.has('--no-paid');
const RUN_CHAT = !args.has('--no-chat');
const apiKey = process.env.HYPEROUTER_API_KEY || process.env.HYPEROUTER_KEY || 'proxy-injected';
const client = new HyperouterClient({ apiKey });
const here = dirname(fileURLToPath(import.meta.url));
const startedAt = new Date().toISOString();

let liveCatalog: Catalog | null = null;

const report: string[] = [];
const log = (line = '') => {
  console.log(line);
};

function fmtUsd(n: number | null | undefined): string {
  return n == null ? 'n/a' : `$${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
}

// ---------------------------------------------------------------- 1. models
async function modelsDiff(): Promise<{ ok: boolean; section: string }> {
  const t0 = Date.now();
  let raw: unknown;
  try {
    raw = (await client.json<unknown>('/v1/models')).data;
  } catch (e) {
    const err = e as HyperouterError;
    return {
      ok: false,
      section: `## Models\n\nGET /v1/models failed: ${err.status} ${err.code} — ${err.message}. Real calls stopped.\n`,
    };
  }
  const { catalog, skipped } = Catalog.fromListing(raw);
  liveCatalog = catalog;
  log(`GET /v1/models: ${catalog.size} models in ${Date.now() - t0} ms`);
  const lines: string[] = [`## Models (GET /v1/models, ${catalog.size} parsed, ${skipped.length} skipped)\n`];
  lines.push('| Id | Name | Flags | Credits (5 s per resolution, or per image) |');
  lines.push('|---|---|---|---|');
  for (const m of catalog.models) {
    if (m.kind === 'chat') continue;
    const res = m.resolutions.length ? m.resolutions : [undefined];
    const credits = res
      .map((r) => {
        try {
          return `${r ?? 'default'} ${creditsFor(m, { ...(r && { resolution: r }), ...(m.kind === 'video' && { seconds: 5 }), ...(!m.operations.includes('t2i') && m.kind === 'image' && { inputImages: Math.max(1, m.minInputImages) }) })}`;
        } catch {
          return `${r ?? 'default'} n/a`;
        }
      })
      .join(', ');
    const flags = [
      m.default && 'default',
      m.auto && 'auto',
      m.matureRouting !== 'never' && `mature:${m.matureRouting}`,
      m.requiresIdentitySafety && 'identity',
      m.substituteFor && `for ${m.substituteFor}`,
      !(m.id in MODEL_OVERLAY) && 'new',
    ].filter(Boolean);
    lines.push(`| \`${m.id}\` | ${m.displayName} | ${flags.join(', ')} | ${credits} |`);
  }
  const missing = Object.keys(MODEL_OVERLAY).filter((id) => !catalog.get(id));
  lines.push('');
  lines.push(`Overlay ids missing from the listing: ${missing.length ? missing.map((i) => `\`${i}\``).join(', ') : 'none'}.`);
  lines.push(`Skipped: ${skipped.length ? skipped.map((x) => `\`${x.id}\` (${x.reason})`).join(', ') : 'none'}.`);
  const unmapped = catalog.models.filter((m) => m.unmapped.length || m.unmappedOperations.length);
  lines.push('');
  lines.push(`Unmapped listing fields (${unmapped.length} models):`);
  lines.push('');
  for (const m of unmapped) lines.push(`- \`${m.id}\`: ${[...m.unmapped, ...m.unmappedOperations.map((o) => `operation:${o}`)].join(', ')}`);
  return { ok: true, section: `${lines.join('\n')}\n` };
}

// ---------------------------------------------------------------- 2. generation
interface GenResult {
  label: string;
  model: string;
  externalId?: string;
  idempotencyKey: string;
  submitMs?: number;
  totalMs?: number;
  final?: JobStatus;
  states: string[];
  estimateUsd: number | null;
  credits: number;
  error?: string;
}

async function runGeneration(
  label: string,
  modelId: string,
  req: Parameters<ReturnType<typeof createHyperouterGenerationProvider>['submit']>[0],
  pollMs: number,
): Promise<GenResult> {
  const model = liveCatalog?.get(modelId);
  if (!model) throw new Error(`Model ${modelId} is not in the live listing.`);
  const provider = createHyperouterGenerationProvider(model, client);
  const cap = provider.capabilities;
  const idempotencyKey = newId('job');
  const result: GenResult = {
    label,
    model: cap.providerModelId,
    idempotencyKey,
    states: [],
    estimateUsd: estimateUsd(cap, req),
    credits: creditsFor(cap, req),
  };
  const t0 = Date.now();
  try {
    const { externalId } = await provider.submit(req, idempotencyKey);
    result.externalId = externalId;
    result.submitMs = Date.now() - t0;
    log(`${label}: submitted ${externalId} in ${result.submitMs} ms`);
    result.final = await pollUntilDone(provider, externalId, {
      intervalMs: pollMs,
      maxIntervalMs: pollMs * 3,
      timeoutMs: 20 * 60 * 1000,
      onStatus: (s) => {
        const tag = `${Math.round((Date.now() - t0) / 1000)}s ${s.providerStatus ?? s.state} ${s.progress}%`;
        if (result.states.at(-1)?.split(' ').slice(1).join(' ') !== tag.split(' ').slice(1).join(' ')) result.states.push(tag);
        log(`${label}: ${tag}`);
      },
    });
    result.totalMs = Date.now() - t0;
  } catch (e) {
    result.totalMs = Date.now() - t0;
    result.error = e instanceof HyperouterError ? `${e.status} ${e.code}: ${e.message}` : String(e);
    log(`${label}: ERROR ${result.error}`);
  }
  return result;
}

function genSection(r: GenResult): string {
  const f = r.final;
  const lines = [
    `### ${r.label}`,
    '',
    `- Model: \`${r.model}\``,
    `- Idempotency-Key: \`${r.idempotencyKey}\``,
    `- External id: \`${r.externalId ?? 'n/a'}\``,
    `- Result: ${r.error ? `**error** ${r.error}` : f ? `${f.state}${f.error ? ` (${f.error.code}: ${f.error.message})` : ''}` : 'n/a'}`,
    `- Cost (usage.cost): ${fmtUsd(f?.costUsd)} — our estimate ${fmtUsd(r.estimateUsd)}; credits ${r.credits}`,
    `- Latency: submit ${r.submitMs ?? 'n/a'} ms, total to final status ${r.totalMs != null ? `${(r.totalMs / 1000).toFixed(1)} s` : 'n/a'}`,
    `- Status trail: ${r.states.join(' → ') || 'n/a'}`,
    `- Outputs (signed, expire):`,
    ...(f?.outputs ?? []).map(
      (o) => `  - ${o.kind}: ${o.url.split('?')[0]}${o.url.includes('?') ? '?…' : ''} (expires ${o.expiresAt ? new Date(o.expiresAt).toISOString() : 'n/a'})`,
    ),
    '',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------- 3. chat
async function runChat(): Promise<string> {
  const llm = new HyperouterLlmProvider(client);
  const events: ChatEvent[] = [];
  const t0 = Date.now();
  let firstTokenMs: number | null = null;
  let firstToolDeltaMs: number | null = null;
  let error: string | null = null;
  try {
    for await (const ev of llm.chat({
      idempotencyKey: newId('message'),
      temperature: 0.3,
      maxTokens: 2000,
      messages: [
        {
          role: 'system',
          content:
            'You plan video projects. Use the pricing.estimate tool whenever the user asks what something costs. Never guess prices.',
        },
        { role: 'user', content: 'How many credits would a 10 second Seedance 2.5 video at 720p cost?' },
      ],
      tools: [
        {
          name: 'pricing.estimate',
          description: 'Estimate the credit cost of a generation before running it.',
          parameters: {
            type: 'object',
            properties: {
              model: { type: 'string', description: 'Model key, e.g. seedance-2.5' },
              seconds: { type: 'integer', minimum: 1, maximum: 30 },
              resolution: { type: 'string', enum: ['480p', '720p', '1080p'] },
            },
            required: ['model', 'seconds'],
            additionalProperties: false,
          },
        },
      ],
      toolChoice: 'auto',
    })) {
      if (firstTokenMs === null && (ev.type === 'text' || ev.type === 'reasoning' || ev.type === 'tool_call_delta')) {
        firstTokenMs = Date.now() - t0;
      }
      if (firstToolDeltaMs === null && ev.type === 'tool_call_delta') firstToolDeltaMs = Date.now() - t0;
      events.push(ev);
    }
  } catch (e) {
    error = e instanceof HyperouterError ? `${e.status} ${e.code}: ${e.message}` : String(e);
  }
  const totalMs = Date.now() - t0;
  const deltas = events.filter((e) => e.type === 'tool_call_delta');
  const calls = events.filter((e): e is Extract<ChatEvent, { type: 'tool_call' }> => e.type === 'tool_call');
  const usage = events.find((e): e is Extract<ChatEvent, { type: 'usage' }> => e.type === 'usage');
  const errEv = events.find((e): e is Extract<ChatEvent, { type: 'error' }> => e.type === 'error');
  const done = events.find((e): e is Extract<ChatEvent, { type: 'done' }> => e.type === 'done');
  const text = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('');
  const reasoningChars = events
    .filter((e) => e.type === 'reasoning')
    .reduce((n, e) => n + (e as { delta: string }).delta.length, 0);
  let parsedOk = false;
  for (const c of calls) {
    try {
      JSON.parse(c.call.arguments);
      parsedOk = true;
    } catch {
      parsedOk = false;
    }
  }
  log(`chat: ${calls.length} tool call(s), ${deltas.length} deltas, ${totalMs} ms`);
  return [
    '## Streamed chat with a tool call',
    '',
    `- Model: \`deepseek/deepseek-v4.1-flash\`, tool \`pricing.estimate\`, tool_choice auto, stream + include_usage`,
    `- Result: ${error ? `**error** ${error}` : errEv ? `stream error ${errEv.error.code}: ${errEv.error.message}` : `finish_reason \`${done?.finishReason}\``}`,
    `- Time to first token/delta: ${firstTokenMs ?? 'n/a'} ms; first tool-call delta: ${firstToolDeltaMs ?? 'n/a'} ms; total ${totalMs} ms`,
    `- Reasoning streamed: ${reasoningChars} chars; text: ${JSON.stringify(text.slice(0, 200))}`,
    `- Tool-call delta events: ${deltas.length} (arguments arrived in ${deltas.filter((d) => (d as { argumentsDelta: string }).argumentsDelta).length} fragments)`,
    `- Assembled tool calls: ${calls.map((c) => `\`${c.call.name}(${c.call.arguments})\` id \`${c.call.id}\``).join(', ') || 'none'}; arguments parse as JSON: ${calls.length ? (parsedOk ? 'yes' : 'no') : 'n/a'}`,
    `- Usage: ${usage ? `prompt ${usage.usage.promptTokens}, completion ${usage.usage.completionTokens}, cached ${usage.usage.cachedTokens}, cost ${fmtUsd(usage.usage.costUsd)}, provider ${usage.provider ?? 'n/a'}` : 'none'}`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- main
async function main() {
  report.push('# M0.5 model spike — results', '');
  report.push(`Run: ${startedAt} (Node ${process.version}). Gateway: ${client.baseUrl}.`, '');

  const models = await modelsDiff();
  if (!models.ok) {
    report.push(models.section);
    finish();
    return;
  }

  const sections: string[] = [];
  if (RUN_PAID) {
    const [image, video] = await Promise.all([
      runGeneration(
        'Image — Seedream 5.0 Lite (async)',
        'bytedance/seedream-5.0-lite',
        { kind: 'image', mode: 't2i', prompt: 'A red vintage bicycle leaning on a white wall, morning light, photo' },
        2000,
      ),
      runGeneration(
        'Video — Seedance 2.0 Mini, 5 s, 480p',
        'bytedance/seedance-2.0-mini',
        {
          kind: 'video',
          mode: 't2v',
          prompt: 'A paper boat drifts down a narrow stream, slow dolly shot, soft daylight',
          seconds: 5,
          resolution: '480p',
          ratio: '16:9',
          audio: false,
        },
        5000,
      ),
    ]);
    sections.push('## Generation', '', genSection(image), genSection(video));
  } else {
    sections.push('## Generation', '', 'Skipped (--no-paid).', '');
  }
  if (RUN_CHAT) sections.push(await runChat());
  report.push(...sections, models.section);
  finish();
}

function finish() {
  const path = join(here, 'RESULTS.md');
  writeFileSync(path, `${report.join('\n')}\n`);
  log(`\nWrote ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
