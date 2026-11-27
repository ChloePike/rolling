/**
 * Auto captions (D-033): a Whisper transcript (Workers AI
 * `@cf/openai/whisper-large-v3-turbo`, words with timings) becomes timed
 * caption cues for the editor's caption track, and the caption track becomes
 * SRT / WebVTT files. Pure: no I/O.
 *
 * Cues are cut at sentence ends, pauses, a length limit (two lines; CJK lines
 * hold fewer characters) and a duration limit, so every cue stays readable at
 * the speed it is spoken. Text without word timings (older outputs) is spread
 * over its segment by character count.
 */
import { CAPTION_LOOKS } from './styles';
import { clipEnd, isCaptionClip, type CaptionClip, type CaptionStyleId, type Clip, type Edl, type TimelineOp } from '../timeline/types';

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words?: TranscriptWord[];
}

export interface Transcript {
  /** Detected (or requested) language code, e.g. `en`, `ja`, `zh`; null when unknown. */
  language: string | null;
  languageProbability?: number;
  /** Seconds of audio transcribed. */
  duration?: number;
  text: string;
  segments: TranscriptSegment[];
}

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

export const CAPTION_TIMING = {
  /** Longest a cue stays on screen. */
  maxSeconds: 6,
  /** Shortest a cue stays on screen (when the next one leaves room). */
  minSeconds: 0.8,
  /** A pause this long starts a new cue. */
  pauseSeconds: 0.7,
} as const;

const EPS = 1e-6;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Han, kana, hangul and CJK punctuation: scripts written without spaces between words. */
const CJK = /[　-〿぀-ヿㇰ-ㇿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/;
const CJK_ALL = new RegExp(CJK.source, 'g');

export function isCjkText(text: string): boolean {
  const letters = text.replace(/[\s\p{P}\d]/gu, '');
  if (!letters) return false;
  return (letters.match(CJK_ALL)?.length ?? 0) / letters.length >= 0.3;
}

/** Whisper languages written without spaces, which wrap by character. */
export function isCjkLanguage(lang: string | null | undefined): boolean {
  return !!lang && /^(zh|ja|ko|yue)\b/i.test(lang);
}

/** Whisper's language names and codes to a BCP 47 primary code (`english` → `en`, `zh` stays). */
const LANGUAGE_NAMES: Record<string, string> = {
  english: 'en', chinese: 'zh', japanese: 'ja', korean: 'ko', spanish: 'es', portuguese: 'pt', german: 'de', french: 'fr',
  indonesian: 'id', thai: 'th', vietnamese: 'vi', cantonese: 'yue', italian: 'it', russian: 'ru', arabic: 'ar', hindi: 'hi',
};

export function normalizeLanguage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (LANGUAGE_NAMES[v]) return LANGUAGE_NAMES[v]!;
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(v) ? v : null;
}

/**
 * Whisper output (Workers AI schema: `transcription_info`, `segments[].words`)
 * to a Transcript, shifted by `offset` seconds (a chunk of a longer track).
 * Unknown shapes give an empty transcript, never a throw.
 */
export function parseWhisper(raw: unknown, offset = 0): Transcript {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const info = (r.transcription_info && typeof r.transcription_info === 'object' ? r.transcription_info : {}) as Record<string, unknown>;
  const segments: TranscriptSegment[] = [];
  for (const s of Array.isArray(r.segments) ? r.segments : []) {
    if (!s || typeof s !== 'object') continue;
    const seg = s as Record<string, unknown>;
    if (!finite(seg.start) || !finite(seg.end) || typeof seg.text !== 'string') continue;
    const words: TranscriptWord[] = [];
    for (const w of Array.isArray(seg.words) ? seg.words : []) {
      const word = w as Record<string, unknown>;
      if (!word || typeof word.word !== 'string' || !finite(word.start) || !finite(word.end)) continue;
      words.push({ word: word.word, start: round3(word.start + offset), end: round3(Math.max(word.start, word.end) + offset) });
    }
    segments.push({ start: round3(seg.start + offset), end: round3(Math.max(seg.start, seg.end) + offset), text: seg.text, ...(words.length && { words }) });
  }
  const text = typeof r.text === 'string' ? r.text : segments.map((s) => s.text).join(' ');
  return {
    language: normalizeLanguage(info.language),
    ...(finite(info.language_probability) && { languageProbability: info.language_probability }),
    ...(finite(info.duration) && { duration: info.duration }),
    text: text.trim(),
    segments,
  };
}

/** Joins chunk transcripts (already offset): the language is the most confident one. */
export function mergeTranscripts(parts: readonly Transcript[]): Transcript {
  const segments = parts.flatMap((p) => p.segments).sort((a, b) => a.start - b.start);
  let best: Transcript | undefined;
  for (const p of parts) if (p.language && (!best || (p.languageProbability ?? 0) > (best.languageProbability ?? 0))) best = p;
  const duration = parts.reduce((s, p) => s + (p.duration ?? 0), 0);
  return {
    language: best?.language ?? null,
    ...(best?.languageProbability !== undefined && { languageProbability: best.languageProbability }),
    ...(duration > 0 && { duration }),
    text: parts.map((p) => p.text).filter(Boolean).join(' ').trim(),
    segments,
  };
}

interface Token {
  text: string;
  start: number;
  end: number;
  cjk: boolean;
}

/** Words of a segment; without word timings, its text split into words (or characters) timed by length. */
function tokensOf(seg: TranscriptSegment): Token[] {
  if (seg.words?.length) return seg.words.filter((w) => w.word.trim()).map((w) => ({ text: w.word, start: w.start, end: w.end, cjk: isCjkText(w.word) }));
  const text = seg.text.trim();
  if (!text) return [];
  const pieces = isCjkText(text) ? (text.match(/[^\s]{1,2}/gu) ?? []) : text.split(/\s+/).map((p, i) => (i === 0 ? p : ` ${p}`));
  const total = pieces.reduce((s, p) => s + p.trim().length, 0) || 1;
  const span = Math.max(0, seg.end - seg.start);
  let t = seg.start;
  return pieces.map((p) => {
    const d = (span * p.trim().length) / total;
    const tok = { text: p, start: t, end: t + d, cjk: isCjkText(p) };
    t += d;
    return tok;
  });
}

const SENTENCE_END = /[.!?。！？…]["')\]」』]?$/u;

function joinTokens(tokens: readonly Token[]): string {
  const spaced = tokens.some((t) => /^\s/.test(t.text));
  let out = '';
  for (const t of tokens) {
    if (spaced || t.cjk || !out || /^[\p{P}]/u.test(t.text.trim())) out += t.text;
    else out += ` ${t.text}`;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Visible length: CJK characters count as one each, like Latin ones (the line limits differ instead). */
const visible = (s: string) => [...s].length;

/**
 * Wraps a cue into at most two lines near the middle: at a space for spaced
 * scripts, after punctuation (else at the middle) for CJK.
 */
export function wrapCaption(text: string, lineChars: number): string {
  const chars = [...text];
  if (chars.length <= lineChars) return text;
  const mid = chars.length / 2;
  if (!isCjkText(text)) {
    let best = -1;
    for (let i = 0; i < chars.length; i++) if (chars[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
    if (best > 0) return `${chars.slice(0, best).join('')}\n${chars.slice(best + 1).join('')}`;
    return text;
  }
  let cut = Math.round(mid);
  for (let d = 0; d <= Math.ceil(chars.length / 4); d++) {
    for (const i of [Math.round(mid) + d, Math.round(mid) - d]) {
      if (i > 0 && i < chars.length && /[、，。！？,.!?\s]/u.test(chars[i - 1]!)) {
        cut = i;
        d = Infinity;
        break;
      }
    }
  }
  return `${chars.slice(0, cut).join('').trim()}\n${chars.slice(cut).join('').trim()}`;
}

export interface CueOptions {
  /** The caption look decides the line length and line count (bold social: one short line). */
  style?: CaptionStyleId;
  /** Shift every cue (the audio started this far into the timeline). */
  offset?: number;
  /** Cues end before this time (the end of the transcribed range). */
  until?: number;
}

/** Timed caption cues from a transcript, wrapped for the style. */
export function cuesFromTranscript(t: Transcript, opts: CueOptions = {}): CaptionCue[] {
  const look = CAPTION_LOOKS[opts.style ?? 'clean'];
  const offset = opts.offset ?? 0;
  const tokens = t.segments.flatMap(tokensOf).sort((a, b) => a.start - b.start);
  const cjkLang = isCjkLanguage(t.language) || (t.language === null && isCjkText(t.text));
  const lineChars = cjkLang ? look.lineChars.cjk : look.lineChars.latin;
  const maxChars = lineChars * look.maxLines;
  const groups: Token[][] = [];
  let cur: Token[] = [];
  for (const tok of tokens) {
    const prev = cur[cur.length - 1];
    if (prev) {
      const nextText = joinTokens([...cur, tok]);
      const tooLong = visible(nextText) > maxChars;
      const tooSlow = tok.end - cur[0]!.start > CAPTION_TIMING.maxSeconds;
      const pause = tok.start - prev.end > CAPTION_TIMING.pauseSeconds;
      const sentence = SENTENCE_END.test(prev.text.trim()) && prev.end - cur[0]!.start >= CAPTION_TIMING.minSeconds;
      if (tooLong || tooSlow || pause || sentence) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(tok);
  }
  if (cur.length) groups.push(cur);

  const cues: CaptionCue[] = [];
  for (const g of groups) {
    const text = joinTokens(g);
    if (!text) continue;
    cues.push({ start: g[0]!.start + offset, end: g[g.length - 1]!.end + offset, text: wrapCaption(text, lineChars) });
  }
  // Minimum on-screen time where there is room; never overlap the next cue or pass `until`.
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]!;
    const next = cues[i + 1];
    const limit = Math.min(next ? next.start : Infinity, opts.until ?? Infinity);
    c.end = Math.min(Math.max(c.end, c.start + CAPTION_TIMING.minSeconds), limit);
    c.start = round3(Math.max(0, c.start));
    c.end = round3(c.end);
  }
  return cues.filter((c) => c.end - c.start >= 0.1 - EPS);
}

/** `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (WebVTT). */
export function cueTime(t: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (v: number, n = 2) => String(v).padStart(n, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

export function toSrt(cues: readonly CaptionCue[]): string {
  return cues
    .filter((c) => c.text.trim())
    .map((c, i) => `${i + 1}\n${cueTime(c.start, ',')} --> ${cueTime(c.end, ',')}\n${c.text.replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n').trim()}\n`)
    .join('\n');
}

export function toVtt(cues: readonly CaptionCue[], lang?: string | null): string {
  const body = cues
    .filter((c) => c.text.trim())
    .map((c) => {
      const text = c.text.replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n').trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `${cueTime(c.start, '.')} --> ${cueTime(c.end, '.')}\n${text}\n`;
    })
    .join('\n');
  return `WEBVTT${lang ? `\nLanguage: ${lang}` : ''}\n\n${body}`;
}

/** Caption cues of an EDL (every caption track, by time), cut to `[0, duration]` when given. */
export function cuesOfEdl(edl: Edl, duration?: number): CaptionCue[] {
  const out: CaptionCue[] = [];
  for (const t of edl.tracks) {
    if (t.kind !== 'caption') continue;
    for (const c of t.clips) {
      const end = duration === undefined ? c.end : Math.min(c.end, duration);
      if (end - c.start > EPS && c.text.trim()) out.push({ start: c.start, end, text: c.text });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export interface CaptionPatchOptions {
  /** Remove captions already in `range` first (else new cues that would overlap them are skipped). */
  replace: boolean;
  range?: { start: number; end: number };
  style?: CaptionStyleId;
  lang?: string | null;
}

/**
 * Ops that put cues on a caption track: removals (replace), inserts with new
 * clip ids, and the track's style / language. Never overlaps a kept caption.
 */
export function captionPatchOps(edl: Edl, trackId: string, cues: readonly CaptionCue[], opts: CaptionPatchOptions): TimelineOp[] {
  const track = edl.tracks.find((t) => t.id === trackId && t.kind === 'caption');
  if (!track) return [];
  const range = opts.range ?? { start: 0, end: Infinity };
  const ops: TimelineOp[] = [];
  const inRange = (c: CaptionClip) => c.end > range.start + EPS && c.start < range.end - EPS;
  const kept: CaptionClip[] = [];
  for (const c of track.clips as CaptionClip[]) {
    if (opts.replace && inRange(c)) ops.push({ op: 'remove', clipId: c.id, ripple: false });
    else kept.push(c);
  }
  const used = new Set<string>();
  for (const t of edl.tracks) for (const c of t.clips as Clip[]) used.add(c.id);
  let n = 1;
  const nextId = () => {
    while (used.has(`cap${n}`)) n++;
    used.add(`cap${n}`);
    return `cap${n}`;
  };
  for (const cue of cues) {
    if (kept.some((k) => cue.start < k.end - EPS && cue.end > k.start + EPS)) continue;
    ops.push({ op: 'insert', trackId, clip: { id: nextId(), start: cue.start, end: cue.end, text: cue.text } });
  }
  if (opts.style || opts.lang !== undefined) {
    ops.push({ op: 'setCaptionTrack', trackId, ...(opts.style && { style: opts.style }), ...(opts.lang !== undefined && { lang: opts.lang }) });
  }
  return ops;
}

/** The first caption track of an EDL, if any. */
export function captionTrackOf(edl: Edl): { id: string; style?: CaptionStyleId; lang?: string } | null {
  const t = edl.tracks.find((x) => x.kind === 'caption');
  return t && t.kind === 'caption' ? { id: t.id, ...(t.style && { style: t.style }), ...(t.lang && { lang: t.lang }) } : null;
}

/** Media clips of an EDL that carry sound for a caption source. */
export type CaptionSource = { kind: 'timeline' } | { kind: 'voice' } | { kind: 'clip'; clipId: string };

/**
 * The EDL whose audio is transcribed: the whole mix, only the voice lane(s), or
 * one clip (kept at its timeline position, so the cues land under it). Null
 * when there is nothing with sound; `range` is the span to transcribe.
 */
export function captionSourceEdl(edl: Edl, source: CaptionSource): { edl: Edl; range: { start: number; end: number } } | null {
  const tracks = edl.tracks.filter((t) => t.kind !== 'caption').map((t) => {
    if (source.kind === 'voice' && t.kind !== 'voice') return { ...t, clips: [] };
    if (source.kind === 'clip') return { ...t, clips: (t.clips as Clip[]).filter((c) => c.id === source.clipId) } as typeof t;
    return t;
  });
  const clips = tracks.flatMap((t) => t.clips as Clip[]).filter((c) => !isCaptionClip(c) && c.assetId);
  if (!clips.length) return null;
  const start = Math.min(...clips.map((c) => c.start));
  const end = Math.max(...clips.map((c) => clipEnd(c)));
  return { edl: { ...edl, tracks: tracks as Edl['tracks'] }, range: { start, end } };
}
