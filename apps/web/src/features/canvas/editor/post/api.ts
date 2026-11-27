/**
 * Post-production calls (docs/api.md → Post-production; D-033 .. D-037):
 * auto captions (Whisper), extend clip and lip-sync quotes, voiceover split,
 * voice rights, resize and the workspace brand kit. Mock mode answers from
 * the editor's mock timeline so the dev route and Playwright run offline.
 */
import { captionPatchOps, captionTrackOf, cuesFromTranscript, type BrandKit, type BrandKitInput } from '@rolling/core/post';
import type { CaptionStyleId, Edl, TimelineOp } from '@rolling/core/timeline';
import { apiFetch, devUser, isMockApi } from '@/features/overlays/backend';
import type { SpecQuote } from '@/features/overlays/runs';
import { apiUrl, getWorkspaceId } from '@/lib/api';
import { canvasIdFor } from '../realTimeline';

export type CaptionSource = { kind: 'timeline' } | { kind: 'voice' } | { kind: 'clip'; clipId: string };

export interface PostJob {
  id: string;
  kind: 'captions' | 'transcript' | 'resize';
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  result: { language?: string | null; cues?: number; assetId?: string; text?: string } | null;
  error: { code: string; message: string } | null;
}

export interface CaptionRequest {
  source: CaptionSource;
  style?: CaptionStyleId;
  /** `auto` detects the spoken language. */
  language: 'auto' | string;
  replace?: boolean;
  transcriptOnly?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mock transcript (what a short voiceover says), for the dev route and tests. */
const MOCK_WHISPER = {
  language: 'en',
  text: 'Morning on the ridge. One sip and the day opens up.',
  segments: [
    {
      start: 0.4,
      end: 4.2,
      text: 'Morning on the ridge. One sip and the day opens up.',
      words: [
        { word: ' Morning', start: 0.4, end: 0.8 },
        { word: ' on', start: 0.8, end: 0.9 },
        { word: ' the', start: 0.9, end: 1.0 },
        { word: ' ridge.', start: 1.0, end: 1.6 },
        { word: ' One', start: 2.1, end: 2.3 },
        { word: ' sip', start: 2.3, end: 2.6 },
        { word: ' and', start: 2.6, end: 2.8 },
        { word: ' the', start: 2.8, end: 2.9 },
        { word: ' day', start: 2.9, end: 3.2 },
        { word: ' opens', start: 3.2, end: 3.6 },
        { word: ' up.', start: 3.6, end: 4.2 },
      ],
    },
  ],
};

/**
 * Captions for the cut. Real mode: `POST /api/canvases/:id/captions`, then
 * `GET /api/post-jobs/:id` until done (the timeline change arrives like any
 * remote edit). Mock mode: the mock transcript's ops, for the editor to commit.
 */
export async function runCaptions(projectId: string, edl: Edl, req: CaptionRequest, onProgress: (p: number) => void, apply: (ops: TimelineOp[]) => void): Promise<PostJob> {
  if (isMockApi()) {
    for (const p of [0.2, 0.5, 0.8]) {
      onProgress(p);
      await sleep(120);
    }
    const track = captionTrackOf(edl);
    if (track && !req.transcriptOnly) {
      const cues = cuesFromTranscript(MOCK_WHISPER, { ...(req.style && { style: req.style }) });
      const ops = captionPatchOps(edl, track.id, cues, { replace: req.replace ?? true, range: { start: 0, end: 5 }, ...(req.style && { style: req.style }), lang: req.language === 'auto' ? 'en' : req.language });
      apply(ops);
    }
    return { id: 'pjb_mock', kind: req.transcriptOnly ? 'transcript' : 'captions', status: 'done', progress: 1, result: { language: 'en', cues: 2, text: MOCK_WHISPER.text }, error: null };
  }
  const { job } = await apiFetch<{ job: PostJob }>(`/canvases/${encodeURIComponent(canvasIdFor(projectId))}/captions`, { method: 'POST', body: req });
  return followJob(job, onProgress);
}

export async function followJob(job: PostJob, onProgress: (p: number) => void): Promise<PostJob> {
  let j = job;
  for (let i = 0; i < 900 && j.status !== 'done' && j.status !== 'failed'; i++) {
    await sleep(i < 10 ? 800 : 2000);
    j = (await apiFetch<{ job: PostJob }>(`/post-jobs/${encodeURIComponent(j.id)}`)).job;
    onProgress(j.progress);
  }
  return j;
}

export interface PlacedQuote extends SpecQuote {
  placementId: string | null;
}

/** Extend clip quote (D-036): last frame → first frame of an image-to-video run. */
export async function quoteExtend(projectId: string, body: { clipId: string; prompt: string; seconds?: number }): Promise<PlacedQuote> {
  if (isMockApi()) return mockQuote('Extended shot', 210);
  return apiFetch<PlacedQuote>(`/canvases/${encodeURIComponent(canvasIdFor(projectId))}/extend/quote`, { method: 'POST', body });
}

/** Lip-sync quote (D-037): a shot's picture speaks a voice clip. */
export async function quoteLipSync(projectId: string, body: { shotClipId: string; voiceClipId: string; prompt?: string }): Promise<PlacedQuote> {
  if (isMockApi()) return mockQuote('Lip-synced shot', 420);
  return apiFetch<PlacedQuote>(`/canvases/${encodeURIComponent(canvasIdFor(projectId))}/lipsync/quote`, { method: 'POST', body });
}

function mockQuote(title: string, credits: number): PlacedQuote {
  return {
    quoteId: 'qt_mock',
    placementId: 'plc_mock',
    items: [{ ref: 'spec', title, kind: 'video', action: 'run', model: 'bytedance/seedance-2.0-mini', modelName: 'Seedance 2.0 Mini', credits, dependsOn: [] }],
    total: credits,
    balance: 2480,
    balanceAfter: 2480 - credits,
    expiresAt: Date.now() + 600_000,
    confirmThreshold: 300,
    needsConfirm: credits >= 300,
  } as unknown as PlacedQuote;
}

/** Splits a voice clip on its pauses (and lines the parts up with the shots). */
export async function splitVoiceover(projectId: string, clipId: string, assign: boolean): Promise<{ parts: string[] }> {
  if (isMockApi()) return { parts: [clipId] };
  return apiFetch<{ parts: string[] }>(`/canvases/${encodeURIComponent(canvasIdFor(projectId))}/voiceover/split`, { method: 'POST', body: { clipId, assign } });
}

/** “I have the rights to use this voice” (D-037). */
export async function attestVoiceRights(assetId: string): Promise<void> {
  if (isMockApi()) return;
  await apiFetch(`/assets/${encodeURIComponent(assetId)}/voice-rights`, { method: 'POST', body: {} });
}

export async function resizeAsset(assetId: string, target: '1080p' | '4K', at?: { projectId: string; nodeId: string }): Promise<PostJob> {
  if (isMockApi()) return { id: 'pjb_mock', kind: 'resize', status: 'done', progress: 1, result: { assetId }, error: null };
  return (await apiFetch<{ job: PostJob }>(`/assets/${encodeURIComponent(assetId)}/resize`, { method: 'POST', body: { target, ...(at ?? {}) } })).job;
}

// ---------------------------------------------------------------- brand kit

export type BrandKitView = Omit<BrandKit, 'fonts'> & { fonts: (BrandKit['fonts'][number] & { url: string })[]; logoUrl: string | null };

let mockKit: BrandKitView = {
  logoAssetId: null,
  logoUrl: null,
  colors: [],
  headingFontId: null,
  captionFontId: null,
  intro: { enabled: false, text: '', seconds: 2, background: null, showLogo: true },
  outro: { enabled: false, text: '', seconds: 2, background: null, showLogo: true },
  watermark: { enabled: false, position: 'bottom_right', opacity: 0.85, size: 0.12 },
  tone: '',
  fonts: [],
  updatedAt: null,
};

export async function getBrandKit(): Promise<BrandKitView> {
  if (isMockApi()) return mockKit;
  return (await apiFetch<{ brandKit: BrandKitView }>('/brand-kit')).brandKit;
}

export async function saveBrandKit(input: BrandKitInput): Promise<BrandKitView> {
  if (isMockApi()) {
    mockKit = { ...mockKit, ...input, updatedAt: Date.now() };
    return mockKit;
  }
  return (await apiFetch<{ brandKit: BrandKitView }>('/brand-kit', { method: 'PUT', body: input })).brandKit;
}

/** Font upload (raw body; the license confirmation is required by the server). */
export async function uploadBrandFont(file: File, family: string): Promise<BrandKitView> {
  if (isMockApi()) {
    const id = `fnt_mock${mockKit.fonts.length + 1}xx`;
    const format = file.name.toLowerCase().endsWith('.otf') ? 'otf' : file.name.toLowerCase().endsWith('.ttf') ? 'ttf' : 'woff2';
    mockKit = { ...mockKit, fonts: [...mockKit.fonts, { id, family, fileName: file.name, format, size: file.size, licenseConfirmed: true, url: '' }] };
    return mockKit;
  }
  const dev = devUser();
  const ws = getWorkspaceId();
  const res = await fetch(apiUrl('/brand-kit/fonts'), {
    method: 'POST',
    credentials: 'include',
    body: file,
    headers: {
      'content-type': file.type || 'application/octet-stream',
      'x-file-name': encodeURIComponent(file.name),
      'x-font-family': encodeURIComponent(family),
      'x-license-confirmed': 'true',
      ...(dev ? { 'x-dev-user': dev } : {}),
      ...(ws ? { 'x-workspace-id': ws } : {}),
    },
  });
  const body = (await res.json()) as { brandKit?: BrandKitView; error?: { message?: string } };
  if (!res.ok || !body.brandKit) throw new Error(body.error?.message ?? `status ${res.status}`);
  return body.brandKit;
}

export async function deleteBrandFont(fontId: string): Promise<BrandKitView> {
  if (isMockApi()) {
    mockKit = { ...mockKit, fonts: mockKit.fonts.filter((f) => f.id !== fontId), captionFontId: mockKit.captionFontId === fontId ? null : mockKit.captionFontId, headingFontId: mockKit.headingFontId === fontId ? null : mockKit.headingFontId };
    return mockKit;
  }
  return (await apiFetch<{ brandKit: BrandKitView }>(`/brand-kit/fonts/${encodeURIComponent(fontId)}`, { method: 'DELETE' })).brandKit;
}
