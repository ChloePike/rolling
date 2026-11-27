/**
 * Prompt lint: format checks for a prompt that is about to go to one model
 * family. Used by the offline graders (packages/agent/evals) and by tests;
 * nothing at run time depends on it.
 */
import type { CatalogModel } from '../models/types';
import { profileOf, type FamilyProfile } from './families';
import type { PromptPurpose } from './shot';

export type LintCode =
  | 'empty'
  | 'too_long'
  | 'too_short'
  | 'too_wordy'
  | 'language'
  | 'markup'
  | 'credits'
  | 'no_camera'
  | 'many_camera_moves'
  | 'multi_shot'
  | 'negative_phrasing'
  | 'hype'
  | 'static_in_animate'
  | 'speech_unsupported'
  | 'unquoted_speech';

export interface LintIssue {
  code: LintCode;
  detail: string;
}

export interface LintContext {
  purpose: PromptPurpose;
  /** Check the vendor's word targets too (composed prompts and agent-written ones; not raw user text). */
  strict?: boolean;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const QUOTED = /"[^"]*"|“[^”]*”|「[^」]*」/g;
const CAMERA =
  /\b(camera|shot|close-?up|wide|angle|pan(?:s|ning)?|tilt(?:s|ing)?|zoom(?:s|ing)?|push(?:es|ing)? in|pull(?:s|ing)? (?:out|back)|track(?:s|ing)?|orbit(?:s|ing)?|handheld|aerial|overhead|pov|first-person|dolly|framing|composition)\b/i;
const MOVE_VERBS =
  /\b(?:camera|shot)\s+(?:slowly\s+|quickly\s+|then\s+)?(push(?:es)? in|pulls? (?:out|back)|pans?|tilts?|zooms?|tracks?|orbits?|follows?|rises?|lowers?|moves?|circles?|dollies|dolly)/gi;
const HYPE = /\b(amazing|stunning|epic|breathtaking|magical|masterpiece|award-winning|mind-?blowing|incredible|ultra-?realistic|hyper-?realistic|8k|best quality)\b/i;
/** Negative controls the vendors document (subtitles, speech, music); anything else should be said positively. */
const ALLOWED_NEGATIVES = /\bno (?:subtitles|bgm|background music|dialogue|audio|music|text|captions|people|cuts)\b/gi;
const NEGATION = /\b(?:no|without|don'?t|do not|never|avoid)\b/gi;
const MULTI_SHOT = /\b(?:cut to|cuts to|next shot|then cut|shot [2-9]\b|scene [2-9]\b|montage)\b/i;
const STATIC_WORDS = /\b(wearing|background|in the background|is dressed|has (?:long|short|dark|blonde|brown|black|red|grey|gray) hair|lit by|lighting)\b/gi;

export function wordCount(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const latin = text.replace(CJK, ' ').split(/\s+/).filter(Boolean).length;
  // A CJK character carries about half an English word.
  return latin + Math.round(cjk / 2);
}

/** Checks a prompt against a family profile. Empty list = fine. */
export function lintForProfile(prompt: string, profile: FamilyProfile, ctx: LintContext): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (code: LintCode, detail: string) => issues.push({ code, detail });
  const text = prompt.trim();
  if (!text) return [{ code: 'empty', detail: 'empty prompt' }];
  if (text.length > profile.maxChars) add('too_long', `${text.length} characters, the limit is ${profile.maxChars}`);

  const unquoted = text.replace(QUOTED, ' ');
  const cjk = unquoted.match(CJK)?.length ?? 0;
  if (cjk > 0 && !profile.languages.includes('zh')) add('language', `${cjk} CJK characters outside quotes; this model reads English`);
  // Mixed scripts read badly everywhere: a prompt is English or Chinese, with speech quoted as spoken.
  const latinWords = unquoted.replace(CJK, ' ').split(/\s+/).filter((w) => /[a-z]{3,}/i.test(w)).length;
  if (cjk > 8 && latinWords > 8) add('language', 'English and Chinese mixed outside quotes');

  if (/(^|\s)(?:[-*•]\s|#{1,3}\s)|\*\*|\n\s*\n/.test(text)) add('markup', 'markdown, bullets or blank lines');
  if (/\b\d[\d,.]*\s*credits?\b/i.test(text)) add('credits', 'credit numbers do not belong in a prompt');
  if (HYPE.test(unquoted)) add('hype', `quality filler ("${HYPE.exec(unquoted)?.[0]}") instead of visible detail`);

  const negations = (unquoted.match(NEGATION)?.length ?? 0) - (unquoted.match(ALLOWED_NEGATIVES)?.length ?? 0);
  if (negations > 0 && profile.negatives !== 'param') add('negative_phrasing', `${negations} negation(s); say what should be seen instead`);

  const words = wordCount(text);
  if (ctx.purpose !== 'still') {
    if (MULTI_SHOT.test(unquoted)) add('multi_shot', 'more than one shot in one clip');
    const moves = new Set((unquoted.match(MOVE_VERBS) ?? []).map((m) => m.toLowerCase().replace(/\s+(slowly|quickly|then)\s+/, ' ')));
    if (moves.size > 2) add('many_camera_moves', `${moves.size} camera moves in one shot`);
    // A speech label ("Maya says (calm):", "Maya's line:") must be followed by a quoted line. Other labels in the
    // same sentence ("In the shot: Maya.", "Sound: rain.") and the noun "line" (a fishing line) are not speech.
    if (/\b(?:says?|said|asks?|whispers?|shouts?|replies|[’']s line)(?:\s+\([^)]*\)|\s+in an? [^:."“]{1,40} tone)?\s*:\s*[^"“\s]/i.test(text)) add('unquoted_speech', 'spoken words are not in double quotes');
    if (!profile.speech && /\b(?:says?|whispers?|shouts?)\b[^.]*["“]/i.test(text)) add('speech_unsupported', 'this model does not voice speech');
  }
  if (ctx.strict) {
    if (ctx.purpose === 'video') {
      if (!CAMERA.test(unquoted)) add('no_camera', 'no framing or camera wording');
      if (words < profile.words.min) add('too_short', `${words} words, aim for at least ${profile.words.min}`);
      if (words > profile.words.max) add('too_wordy', `${words} words, aim for at most ${profile.words.max}`);
    } else if (ctx.purpose === 'animate') {
      if (words > profile.animateWords) add('too_wordy', `${words} words; with a first frame aim for at most ${profile.animateWords}`);
      const stat = unquoted.match(STATIC_WORDS)?.length ?? 0;
      if (stat >= 3) add('static_in_animate', 'describes the picture again instead of the motion');
    } else {
      if (words < profile.words.min) add('too_short', `${words} words, aim for at least ${profile.words.min}`);
      if (words > profile.words.max) add('too_wordy', `${words} words, aim for at most ${profile.words.max}`);
    }
  }
  return issues;
}

export function lintPrompt(prompt: string, model: Pick<CatalogModel, 'id' | 'kind'>, ctx: LintContext): LintIssue[] {
  return lintForProfile(prompt, profileOf(model), ctx);
}
