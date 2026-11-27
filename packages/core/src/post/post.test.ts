import { describe, expect, it } from 'vitest';
import {
  captionPatchOps,
  captionSourceEdl,
  cuesFromTranscript,
  cuesOfEdl,
  isCjkText,
  mergeTranscripts,
  normalizeLanguage,
  parseWhisper,
  toSrt,
  toVtt,
  wrapCaption,
} from './captions';
import { captionFontStack, cjkFontFor, resolveCaptionLook } from './styles';
import { brandAppliesToExport, brandKitSummary, BrandKitInputSchema, emptyBrandKit, familyFromFileName, fontFormatOf, fontSignatureOk, normalizeBrandKit } from './brandKit';
import { dropPlacement, planAfter, resolvePlacement } from './placement';
import { assignToShots, cutsFromSilences, parseSilences, splitOps } from './voiceover';
import { applyOps } from '../timeline/ops';
import { clipEnd, findClip, type Edl, type MediaClip } from '../timeline/types';
import { exportSize, ExportRequestSchema, needsReframe, PRESET_ENCODE, previewSize } from '../export';
import { planAllowsResize } from '../pricing/config';

const whisper = {
  text: 'Hello there. This is a test of the captions.',
  transcription_info: { language: 'en', language_probability: 0.98, duration: 5 },
  segments: [
    {
      start: 0.2,
      end: 4.6,
      text: ' Hello there. This is a test of the captions.',
      words: [
        { word: ' Hello', start: 0.2, end: 0.6 },
        { word: ' there.', start: 0.6, end: 1.1 },
        { word: ' This', start: 1.4, end: 1.6 },
        { word: ' is', start: 1.6, end: 1.7 },
        { word: ' a', start: 1.7, end: 1.8 },
        { word: ' test', start: 1.8, end: 2.2 },
        { word: ' of', start: 2.2, end: 2.3 },
        { word: ' the', start: 2.3, end: 2.4 },
        { word: ' captions.', start: 2.4, end: 3.1 },
      ],
    },
  ],
};

function edl(): Edl {
  return {
    fps: 24,
    width: 1920,
    height: 1080,
    tracks: [
      { id: 'C1', kind: 'caption', clips: [{ id: 'c1', start: 10, end: 11, text: 'keep' }] },
      { id: 'V1', kind: 'video', clips: [{ id: 'v1', assetId: 'a', in: 0, out: 4, start: 0 }, { id: 'v2', assetId: 'b', in: 0, out: 3, start: 4 }, { id: 'v3', assetId: 'c', in: 0, out: 3, start: 7 }] },
      { id: 'A1', kind: 'voice', clips: [{ id: 'a1', assetId: 'vo', in: 0, out: 9, start: 0 }] },
      { id: 'A2', kind: 'music', clips: [{ id: 'm1', assetId: 'mu', in: 0, out: 10, start: 0 }] },
    ],
  };
}

describe('Whisper transcripts to caption cues', () => {
  it('parses the Workers AI output, offsets chunks and keeps the most confident language', () => {
    const t = parseWhisper(whisper, 10);
    expect(t.language).toBe('en');
    expect(t.segments[0]!.words![0]).toEqual({ word: ' Hello', start: 10.2, end: 10.6 });
    const m = mergeTranscripts([parseWhisper({ ...whisper, transcription_info: { language: 'ja', language_probability: 0.4 } }), t]);
    expect(m.language).toBe('en');
    expect(m.duration).toBe(5);
    expect(parseWhisper(null)).toEqual({ language: null, text: '', segments: [] });
    expect(normalizeLanguage('English')).toBe('en');
    expect(normalizeLanguage('<script>')).toBeNull();
  });

  it('cuts cues at sentence ends and keeps them on screen long enough', () => {
    const cues = cuesFromTranscript(parseWhisper(whisper));
    expect(cues.map((c) => c.text)).toEqual(['Hello there.', 'This is a test of the captions.']);
    expect(cues[0]!.start).toBe(0.2);
    expect(cues[0]!.end).toBeGreaterThanOrEqual(1.0);
    expect(cues[0]!.end).toBeLessThanOrEqual(cues[1]!.start);
  });

  it('bold social uses short single lines', () => {
    const cues = cuesFromTranscript(parseWhisper(whisper), { style: 'bold_social' });
    for (const c of cues) {
      expect(c.text).not.toContain('\n');
      expect([...c.text].length).toBeLessThanOrEqual(22);
    }
  });

  it('wraps CJK by character, without word timings, and detects the script', () => {
    const text = 'これは自動字幕のテストです。日本語の文章を正しく分けて表示します。';
    const cues = cuesFromTranscript({ language: 'ja', text, segments: [{ start: 0, end: 6, text }] });
    expect(cues.length).toBeGreaterThanOrEqual(2);
    for (const c of cues) for (const line of c.text.split('\n')) expect([...line].length).toBeLessThanOrEqual(16);
    expect(cues.map((c) => c.text.replace('\n', '')).join('')).toBe(text);
    expect(isCjkText('字幕')).toBe(true);
    expect(isCjkText('Hello')).toBe(false);
    expect(wrapCaption('a short line', 42)).toBe('a short line');
    expect(wrapCaption('one two three four five six seven eight nine ten eleven', 30)).toContain('\n');
  });

  it('writes SRT and WebVTT', () => {
    const cues = [{ start: 1, end: 2.5, text: 'Hi & <bye>' }, { start: 3661.001, end: 3662, text: 'two\nlines' }];
    expect(toSrt(cues)).toBe('1\n00:00:01,000 --> 00:00:02,500\nHi & <bye>\n\n2\n01:01:01,001 --> 01:01:02,000\ntwo\nlines\n');
    expect(toVtt(cues, 'en')).toBe('WEBVTT\nLanguage: en\n\n00:00:01.000 --> 00:00:02.500\nHi &amp; &lt;bye&gt;\n\n01:01:01.001 --> 01:01:02.000\ntwo\nlines\n');
  });

  it('puts cues on the caption track without overlapping kept captions, with style and language', () => {
    const base = edl();
    const cues = [{ start: 0, end: 2, text: 'a' }, { start: 10.5, end: 12, text: 'overlaps keep' }, { start: 13, end: 14, text: 'b' }];
    const ops = captionPatchOps(base, 'C1', cues, { replace: false, style: 'minimal', lang: 'en' });
    const r = applyOps(base, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.edl.tracks[0]).toMatchObject({ style: 'minimal', lang: 'en' });
    expect(cuesOfEdl(r.edl).map((c) => c.text)).toEqual(['a', 'keep', 'b']);
    const replaced = applyOps(base, captionPatchOps(base, 'C1', cues, { replace: true }));
    expect(replaced.ok && cuesOfEdl(replaced.edl).map((c) => c.text)).toEqual(['a', 'overlaps keep', 'b']);
  });

  it('builds the audio source: whole mix, voice lane, or one clip at its place', () => {
    const voice = captionSourceEdl(edl(), { kind: 'voice' })!;
    expect(voice.edl.tracks.flatMap((t) => t.clips as { id: string }[]).map((c) => c.id)).toEqual(['a1']);
    expect(voice.range).toEqual({ start: 0, end: 9 });
    const clip = captionSourceEdl(edl(), { kind: 'clip', clipId: 'v2' })!;
    expect(clip.range).toEqual({ start: 4, end: 7 });
    expect(captionSourceEdl({ ...edl(), tracks: [] }, { kind: 'timeline' })).toBeNull();
  });
});

describe('caption looks', () => {
  it('picks the regional CJK family and a font stack with fallbacks', () => {
    expect(cjkFontFor('ja')).toBe('Noto Sans CJK JP');
    expect(cjkFontFor('ko')).toBe('Noto Sans CJK KR');
    expect(cjkFontFor('zh-TW')).toBe('Noto Sans CJK TC');
    expect(cjkFontFor('zh')).toBe('Noto Sans CJK SC');
    expect(captionFontStack('ja', 'Brand "X"')).toMatch(/^"Brand X", "Noto Sans", "Noto Sans CJK JP"/);
  });

  it('tints clean boxes and bold text with the brand color, keeping contrast', () => {
    const clean = resolveCaptionLook('clean', { brandColor: '#ffcb2b' });
    expect(clean.boxColor).toBe('#FFCB2B');
    expect(clean.text).toBe('#111111');
    expect(resolveCaptionLook('bold_social', { brandColor: '#3B82F6' }).text).toBe('#3B82F6');
    expect(resolveCaptionLook('bold_social', { brandColor: '#101010' }).text).toBe('#FFFFFF');
    expect(resolveCaptionLook('minimal', { brandColor: '#3B82F6', brandFont: 'Inter' })).toMatchObject({ text: '#FFFFFF', fontFamily: 'Inter' });
  });
});

describe('brand kit', () => {
  it('validates input, fonts and summarises for the agent', () => {
    expect(BrandKitInputSchema.safeParse({ colors: ['#zzzzzz'] }).success).toBe(false);
    const input = BrandKitInputSchema.parse({ colors: ['#ff0000', '#00ff00'], tone: 'Calm, plain words.', watermark: { enabled: true }, logoAssetId: 'ast_1' });
    expect(input.colors).toEqual(['#FF0000', '#00FF00']);
    const kit = { ...emptyBrandKit(), ...input, fonts: [{ id: 'fnt_abcdef', family: 'Inter', fileName: 'Inter.woff2', format: 'woff2' as const, size: 100, licenseConfirmed: true as const }], captionFontId: 'fnt_abcdef', headingFontId: 'fnt_gone' };
    const n = normalizeBrandKit(kit);
    expect(n.headingFontId).toBeNull();
    expect(brandAppliesToExport(n)).toBe(true);
    expect(brandKitSummary(n)).toBe('Brand kit: colors #FF0000, #00FF00 (primary #FF0000); caption font “Inter”; logo watermark bottom right. Tone: Calm, plain words.');
    expect(brandKitSummary(emptyBrandKit())).toBeNull();
    expect(fontFormatOf('A.WOFF2')).toBe('woff2');
    expect(fontFormatOf('a.exe')).toBeNull();
    expect(fontSignatureOk('woff2', new TextEncoder().encode('wOF2xxxx'))).toBe(true);
    expect(fontSignatureOk('ttf', new Uint8Array([0, 1, 0, 0]))).toBe(true);
    expect(fontSignatureOk('otf', new Uint8Array([0, 1, 0, 0]))).toBe(false);
    expect(familyFromFileName('Inter-Bold_v2.ttf')).toBe('Inter Bold v2');
  });
});

describe('extend placement', () => {
  it('plans a clip after the original, rippling later clips, then resolves it to the real length', () => {
    const base = edl();
    const plan = planAfter(base, 'v2', 5, { skipHead: 1 / 24 })!;
    const r = applyOps(base, plan.ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const placed = findClip(r.edl, plan.clipId)!.clip as MediaClip;
    expect(placed).toMatchObject({ assetId: null, start: 7, out: 5 });
    expect((findClip(r.edl, 'v3')!.clip as MediaClip).start).toBeCloseTo(7 + 5 - 1 / 24, 5);
    const resolved = resolvePlacement(r.edl, plan.clipId, 'ast_new', 4, 'after')!;
    const p2 = findClip(resolved, plan.clipId)!.clip as MediaClip;
    expect(p2).toMatchObject({ assetId: 'ast_new', out: 4 });
    expect((findClip(resolved, 'v3')!.clip as MediaClip).start).toBeCloseTo(clipEnd(p2), 5);
    const dropped = dropPlacement(r.edl, plan.clipId, 'after')!;
    expect('ops' in dropped).toBe(true);
    if ('ops' in dropped) {
      const back = applyOps(r.edl, dropped.ops);
      expect(back.ok && (findClip(back.edl, 'v3')!.clip as MediaClip).start).toBe(7);
    }
    expect(planAfter(base, 'a1', 5)).toBeNull();
  });

  it('replaces a shot with a lip-synced take, at most the planned length', () => {
    const r = resolvePlacement(edl(), 'v1', 'ast_ls', 9, 'replace')!;
    expect(findClip(r, 'v1')!.clip).toMatchObject({ assetId: 'ast_ls', in: 0, out: 4, start: 0 });
  });
});

describe('voiceover split', () => {
  it('parses silencedetect, cuts in the pauses and lines parts up with the shots', () => {
    const log = '[silencedetect @ 0x1] silence_start: 3.5\n[silencedetect @ 0x1] silence_end: 4.1 | silence_duration: 0.6\nsilence_start: 6.2\nsilence_end: 7.0 | silence_duration: 0.8\nsilence_start: 8.8\n';
    const s = parseSilences(log);
    expect(s).toEqual([{ start: 3.5, end: 4.1 }, { start: 6.2, end: 7 }]);
    const cuts = cutsFromSilences(s, { in: 0, out: 9 });
    expect(cuts).toEqual([3.8, 6.6]);
    const base = edl();
    const split = splitOps(base, 'a1', cuts)!;
    expect(split.partIds).toEqual(['a1', 'a2', 'a3']);
    const r = applyOps(base, split.ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const moves = assignToShots(r.edl, split.partIds);
    const r2 = applyOps(r.edl, moves);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(split.partIds.map((id) => (findClip(r2.edl, id)!.clip as MediaClip).start)).toEqual([0, 4, 7]);
  });
});

describe('export presets', () => {
  it('fixes social frames, reframes on aspect change and normalises loudness', () => {
    const cut = { width: 1920, height: 1080 };
    expect(exportSize(cut, 'vertical_9x16')).toEqual({ width: 1080, height: 1920 });
    expect(exportSize(cut, 'mp4_720p')).toEqual({ width: 1280, height: 720 });
    expect(needsReframe(cut, exportSize(cut, 'vertical_9x16'))).toBe(true);
    expect(needsReframe(cut, exportSize(cut, 'landscape_16x9'))).toBe(false);
    expect(PRESET_ENCODE.vertical_9x16.loudnessLufs).toBe(-14);
    expect(PRESET_ENCODE.mp4_1080p.loudnessLufs).toBeNull();
    expect(previewSize({ width: 1080, height: 1920 })).toEqual({ width: 540, height: 960 });
    expect(ExportRequestSchema.safeParse({ presets: ['square_1x1', 'vertical_9x16'], options: { interpolate: 60, brand: true } }).success).toBe(true);
    expect(ExportRequestSchema.safeParse({ preset: 'mp4_1080p', options: { interpolate: 30 } }).success).toBe(false);
  });

  it('resize targets follow the plan caps', () => {
    expect(planAllowsResize('starter', 'video', '1080p')).toBe(false);
    expect(planAllowsResize('plus', 'video', '1080p')).toBe(true);
    expect(planAllowsResize('plus', 'video', '4K')).toBe(false);
    expect(planAllowsResize('starter', 'image', '1080p')).toBe(true);
    expect(planAllowsResize('pro', 'image', '4K')).toBe(true);
  });
});
