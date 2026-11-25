/**
 * Deterministic D-005 rules: run first, cost nothing, and decide the obvious
 * cases before any classifier call (and at quote time, before credits are held).
 *
 * - Minor-coded terms (multilingual, plus ages under 18) in the same text as
 *   sexual terms → MINOR_SEXUAL. Negated sexual terms ("no nudity") don't count.
 * - Face/head swap or identity-driven models on a mature run with any uploaded
 *   reference → IDENTITY_SWAP_MATURE; face/head swap never takes a mature run.
 * - `explicitSignal`: strong explicit terms, used to ask for mature content
 *   (MATURE_REQUIRED) on runs that don't have it, instead of routing silently.
 *
 * Real-person and celebrity detection is not done here: names need the LLM.
 * Negative prompts are not scanned (they usually list what to avoid).
 */
import type { PreCheckInput, SafetyModel, SafetyReason } from './types';

/** Scripts written without spaces between words: match as substrings. */
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Thai}]/u;

/** Term list split into word-bounded (regex fragments) and substring terms. */
interface TermList {
  words: RegExp | null;
  substrings: string[];
}

function terms(list: readonly string[]): TermList {
  const words = list.filter((t) => !NO_SPACE_SCRIPT.test(t));
  const substrings = list.filter((t) => NO_SPACE_SCRIPT.test(t));
  return {
    words: words.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join('|')})(?![\\p{L}\\p{N}])`, 'gu') : null,
    substrings,
  };
}

// Minor-coded terms. Regex fragments; keep them lowercase.
const MINOR_TERMS = terms([
  // English
  'child(?:ren)?', "child's", 'kids?', 'kiddies', 'minors?', 'under-?aged?', 'pre-?teens?', 'tweens?', 'toddlers?', 'infants?',
  'school ?girls?', 'school ?boys?', 'lolis?', 'lolicon', 'lolita', 'shota(?:con)?', 'jailbait', 'teens?', 'teenagers?', 'teenaged',
  'young teens?', 'little (?:girls?|boys?)', 'young (?:girls?|boys?)', 'barely legal', '(?:high|middle|grade|elementary) ?school(?:ers?)?',
  'girl scouts?', 'boy scouts?', 'juveniles?', 'pubescent', 'prepubescent',
  // Spanish / Portuguese / Italian / French / German / others (Latin script)
  'niñ[oa]s?', 'menor(?:es)? de edad', 'menores', 'adolescentes?', 'colegialas?', 'crianças?', 'menin[oa]s?', 'menor de idade',
  'bambin[aoie]', 'minorenni?', 'ragazzin[aoie]', 'enfants?', 'fillettes?', 'mineures?', 'écolières?', 'collégiennes?', 'gamines?',
  'kinder', 'kindern', 'minderjährigen?', 'schulmädchen', 'jugendlichen?', 'dzieci', 'dziecko', 'nieletni[aey]?', 'çocuk\\p{L}*',
  'reşit olmayan', 'trẻ em', 'anak-anak', 'di bawah umur', 'bocah',
  // Cyrillic
  'ребенок', 'ребёнок', 'ребенка', 'ребёнка', 'дети', 'детей', 'детск\\p{L}*', 'школьниц\\p{L}*', 'школьник\\p{L}*', 'несовершеннолетн\\p{L}*',
  'малолетк\\p{L}*', 'малолетн\\p{L}*', 'подрост\\p{L}*',
  // CJK, Hangul, Arabic, Devanagari (substrings)
  '儿童', '兒童', '幼女', '幼童', '萝莉', '蘿莉', '未成年', '小学生', '小學生', '初中生', '中学生', '中學生', '女童', '男童', '小女孩', '小男孩',
  '少女', '子供', '子ども', 'こども', '児童', 'ロリ', 'ショタ', '女子高生', '女子中学生', '女子小学生', '아동', '어린이', '미성년', '초등학생',
  '중학생', '여중생', '여고생', '로리', '소녀', 'طفل', 'أطفال', 'اطفال', 'قاصر', 'بچه', 'बच्चा', 'बच्चे', 'नाबालिग',
]);

// Ages 1–17 ("15 yo", "12-year-old", "aged 14", "14歳", "14岁", "14살", "15 años").
const MINOR_AGE = [
  /(?<![\p{N}.,])(?:[1-9]|1[0-7])\s*(?:-|\s)?(?:yo|y\/o|y\.o\.?|yrs?\.? old|yrs?-old|years?[\s-]old|year[\s-]old|anos|años|ans|jahre|jährige\p{L}*|лет|года|letni\p{L}*)(?![\p{L}])/u,
  /(?<![\p{L}])(?:aged?|age of|edad de|âgée? de)\s*(?:[1-9]|1[0-7])(?![\p{N}])/u,
  /(?<![\p{N}])(?:[1-9]|1[0-7])\s*(?:歳|岁|歲|살)/u,
];

// Sexual terms (any level, including suggestive). Used only together with minor terms.
const SEXUAL_TERMS = terms([
  // English
  'sex', 'sexy', 'sexual(?:ly|ized|ised|ity)?', 'sexuali[sz]ed?', 'nudes?', 'nudity', 'naked', 'porn\\p{L}*', 'erotic\\p{L}*', 'nsfw',
  'topless', 'bottomless', 'lingerie', 'intercourse', 'orgasm\\p{L}*', 'genital\\p{L}*', 'blowjobs?', 'masturbat\\p{L}*', 'fetish\\p{L}*',
  'seductive(?:ly)?', 'seduc\\p{L}*', 'striptease', 'stripping', 'undress\\p{L}*', 'hentai', 'xxx', 'lewd', 'horny', 'aroused', 'arousing',
  'provocative(?:ly)?', 'sensual(?:ly)?', 'boudoir', 'onlyfans', 'thongs?', 'nipples?', 'fuck\\p{L}*', 'cum', 'ecchi', 'smut\\p{L}*',
  // Spanish / Portuguese / Italian / French / German / others
  'sexo', 'sexuales', 'desnud[oa]s?', 'porno\\p{L}*', 'er[oó]tic[oa]s?', 'lencer[ií]a', 'cachond\\p{L}*', 'follar', 'nuas?', 'transar',
  'sexe', 'sexuel\\p{L}*', 'nues?', 'toute nue', 'érotique\\p{L}*', 'déshabill\\p{L}*', 'nackt\\p{L}*', 'erotisch\\p{L}*', 'sexuell\\p{L}*',
  'unbekleidet\\p{L}*', 'nud[aie]', 'sesso', 'sessual\\p{L}*', 'nag[aie]', 'seks\\p{L}*', 'erotycz\\p{L}*', 'çıplak', 'erotik\\p{L}*',
  'telanjang', 'bugil', 'khỏa thân', 'khiêu dâm', 'tình dục',
  // Cyrillic
  'голы[йе]', 'голая', 'голую', 'обнажен\\p{L}*', 'обнажён\\p{L}*', 'секс\\p{L}*', 'порн\\p{L}*', 'эроти\\p{L}*', 'раздет\\p{L}*',
  // CJK, Hangul, Arabic, Devanagari
  '裸体', '裸體', '全裸', '半裸', '裸露', '裸照', '裸の', 'ヌード', 'エロ', 'セックス', '性的', '性行为', '性行為', '色情', '做爱', '做愛',
  '情色', '成人向け', '淫', '卑猥', '脱衣', '性感', '누드', '섹스', '야한', '알몸', '성적', '음란', 'جنس', 'عاري', 'عارية', 'إباحي',
  'नग्न', 'सेक्स', 'अश्लील',
]);

// Strong explicit terms: a prompt with these needs mature content on (MATURE_REQUIRED).
const EXPLICIT_TERMS = terms([
  'porn\\p{L}*', 'nsfw', 'xxx', 'hentai', 'explicit sex\\p{L}*', 'sex scenes?', 'having sex', 'intercourse', 'blowjobs?', 'masturbat\\p{L}*',
  'orgasm\\p{L}*', 'genitals?', 'fully nude', 'fully naked', 'completely naked', 'sexo explícito', 'porno\\p{L}*', 'pornographique',
  'секс', 'порн\\p{L}*', 'セックス', '色情', '做爱', '做愛', '性行为', '性行為', '섹스', 'सेक्स',
]);

const NEGATION_BEFORE = /(?<![\p{L}])(?:no|not|non|without|never|avoid|zero|nothing|nor|sin|sans|ohne|keine?n?|без|не|nicht|senza|sem)[\s,-]+(?:[\p{L}]+[\s,-]+)?$/u;
const NEGATION_CJK_BEFORE = /[不无無非没禁]$/u;
const NEGATION_CJK_AFTER = /^(?:なし|無し|禁止|없는|없이)/u;

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's' };

/** NFKC, lower case, common character substitutions (`s3xy` → `sexy`), whitespace collapsed. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/(?<=\p{L})[0134578@$]+(?=\p{L})|(?<=\p{L}{2})[0134578@$]+(?![\p{L}\p{N}])/gu, (run) => [...run].map((c) => LEET[c] ?? c).join(''))
    .replace(/\s+/g, ' ')
    .trim();
}

export interface TermHit {
  term: string;
  index: number;
  negated: boolean;
}

function findTerms(text: string, list: TermList): TermHit[] {
  const hits: TermHit[] = [];
  if (list.words) {
    for (const m of text.matchAll(list.words)) {
      const before = text.slice(Math.max(0, m.index - 40), m.index);
      hits.push({ term: m[0], index: m.index, negated: NEGATION_BEFORE.test(before) });
    }
  }
  for (const s of list.substrings) {
    let i = text.indexOf(s);
    while (i !== -1) {
      const before = text.slice(Math.max(0, i - 2), i);
      const after = text.slice(i + s.length, i + s.length + 3);
      hits.push({ term: s, index: i, negated: NEGATION_CJK_BEFORE.test(before) || NEGATION_CJK_AFTER.test(after) });
      i = text.indexOf(s, i + s.length);
    }
  }
  return hits;
}

export function minorTerms(text: string): string[] {
  const t = normalizeText(text);
  const out = findTerms(t, MINOR_TERMS).map((h) => h.term);
  for (const re of MINOR_AGE) {
    const m = re.exec(t);
    if (m) out.push(m[0]);
  }
  return out;
}

/** Sexual terms that are not negated. */
export function sexualTerms(text: string): string[] {
  return findTerms(normalizeText(text), SEXUAL_TERMS)
    .filter((h) => !h.negated)
    .map((h) => h.term);
}

/** Strong explicit terms that are not negated. */
export function explicitSignal(text: string): string[] {
  return findTerms(normalizeText(text), EXPLICIT_TERMS)
    .filter((h) => !h.negated)
    .map((h) => h.term);
}

function isSwap(model: SafetyModel): boolean {
  return !!model.operations?.some((o) => o === 'face_swap' || o === 'head_swap');
}

/** Identity rule (D-005). */
export function identityRule(input: Pick<PreCheckInput, 'mature' | 'model' | 'references'>): SafetyReason | null {
  const model = input.model;
  if (!input.mature || !model) return null;
  if (isSwap(model)) return { code: 'IDENTITY_SWAP_MATURE', detail: `face/head swap ${model.id} never takes a mature run` };
  if (model.requiresIdentitySafety && input.references.some((r) => r.source === 'upload')) {
    return { code: 'IDENTITY_SWAP_MATURE', detail: `identity-driven ${model.id} with an uploaded reference on a mature run` };
  }
  return null;
}

export interface RulesResult {
  reasons: SafetyReason[];
  /** Strong explicit terms found (MATURE_REQUIRED on non-mature runs is decided by the caller). */
  explicit: string[];
}

/**
 * The deterministic part of preCheck. Scans the prompt and reference captions
 * (not the negative prompt).
 */
export function runRules(input: Pick<PreCheckInput, 'prompt' | 'references' | 'mature' | 'model'>): RulesResult {
  const text = [input.prompt, ...input.references.map((r) => r.caption ?? '')].filter(Boolean).join('\n');
  const reasons: SafetyReason[] = [];
  const minors = minorTerms(text);
  const sexual = sexualTerms(text);
  // On a mature run, any minor-coded term is enough: the run is sexual by intent.
  if (minors.length > 0 && (sexual.length > 0 || input.mature)) {
    reasons.push({ code: 'MINOR_SEXUAL', detail: `rules: minor terms [${minors.slice(0, 3).join(', ')}] with ${sexual.length ? `sexual terms [${sexual.slice(0, 3).join(', ')}]` : 'a mature run'}` });
  }
  const identity = identityRule(input);
  if (identity) reasons.push(identity);
  return { reasons, explicit: explicitSignal(text) };
}
