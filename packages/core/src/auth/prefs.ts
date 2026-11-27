import { z } from 'zod';
import { DEFAULT_CONFIRM_THRESHOLD_CREDITS } from '../pricing/config';

/**
 * User preferences (Settings → Preferences, header settings popover).
 * The API shape is camelCase; D1 stores them in `user_prefs` (snake_case).
 */

/**
 * D-023: English source; translated zh-CN, zh-TW, ja, ko; second wave id, th, vi, es, pt-BR, de, fr
 * (English text). `zh-HK` is still accepted from older clients and reads as Traditional Chinese.
 */
export const SUPPORTED_LANGUAGES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'zh-HK', 'id', 'th', 'vi', 'es', 'pt-BR', 'de', 'fr'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** Display currencies. Charges stay in USD (D-006). */
export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'TWD', 'HKD', 'KRW', 'IDR', 'THB', 'VND', 'BRL'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:5', '21:9'] as const;
export const CREATION_MODES = ['simple', 'advanced'] as const;
/** D-010. */
export const THEMES = ['system', 'light', 'dark'] as const;

export const NotificationPrefs = z
  .object({
    done: z.boolean(),
    low: z.boolean(),
    renewal: z.boolean(),
    product: z.boolean(),
    /** D-031: new comments in threads you are part of and on projects you created (in-app). */
    comments: z.boolean(),
    /** D-031: @mentions (in-app and email). */
    mentions: z.boolean(),
    /** D-031: review link decisions and reviewer comments on links you created (in-app; decisions also by email). */
    reviews: z.boolean(),
  })
  .strict();
export type NotificationPrefs = z.infer<typeof NotificationPrefs>;

export interface Prefs {
  language: Language;
  currency: Currency;
  creationMode: (typeof CREATION_MODES)[number];
  defaultRatio: (typeof ASPECT_RATIOS)[number];
  /** A public model id, or "auto". */
  defaultModel: string;
  /** Runs quoted below this many credits start without the run confirm (0 = always confirm). */
  confirmThreshold: number;
  notifications: NotificationPrefs;
  theme: (typeof THEMES)[number];
  /** D-005 visibility preference. Effective only for members whose workspace allows it. */
  matureContent: boolean;
  /** D-020 "Enhance prompt" default for Home, tools and Quick Create (each run can change it). */
  enhancePrompt: boolean;
  /** D-024 "Review results": a cheap vision model reviews each output (badge, issues, "Retry with fix"). */
  reviewResults: boolean;
}

export const DEFAULT_NOTIFICATIONS: NotificationPrefs = { done: true, low: true, renewal: true, product: false, comments: true, mentions: true, reviews: true };

export const DEFAULT_PREFS: Prefs = {
  language: 'en',
  currency: 'USD',
  creationMode: 'simple',
  defaultRatio: '9:16',
  defaultModel: 'auto',
  confirmThreshold: DEFAULT_CONFIRM_THRESHOLD_CREDITS,
  notifications: DEFAULT_NOTIFICATIONS,
  theme: 'system',
  matureContent: false,
  enhancePrompt: true,
  reviewResults: true,
};

/** Upper bound for the confirm threshold (credits); 1 credit = $0.01, so this is $1,000. */
export const MAX_CONFIRM_THRESHOLD = 100_000;

/** `PATCH /api/me/prefs` body: any subset; unknown keys are rejected. */
export const PrefsPatch = z
  .object({
    language: z.enum(SUPPORTED_LANGUAGES),
    currency: z.enum(SUPPORTED_CURRENCIES),
    creationMode: z.enum(CREATION_MODES),
    defaultRatio: z.enum(ASPECT_RATIOS),
    defaultModel: z.string().min(1).max(100).regex(/^[A-Za-z0-9._:/-]+$/),
    confirmThreshold: z.number().int().min(0).max(MAX_CONFIRM_THRESHOLD),
    notifications: NotificationPrefs.partial().strict(),
    theme: z.enum(THEMES),
    matureContent: z.boolean(),
    enhancePrompt: z.boolean(),
    reviewResults: z.boolean(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one preference is required' });
export type PrefsPatch = z.infer<typeof PrefsPatch>;

/** Parses an Accept-Language header into tags ordered by quality (highest first). */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const quality = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim(), quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter((t) => t.tag && t.tag !== '*' && t.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
    .map((t) => t.tag);
}

function canonical(tag: string): { lang: string; region: string | null; script: string | null } {
  const parts = tag.split(/[-_]/);
  const lang = (parts[0] ?? '').toLowerCase();
  let region: string | null = null;
  let script: string | null = null;
  for (const p of parts.slice(1)) {
    if (/^[A-Za-z]{4}$/.test(p)) script = p[0]!.toUpperCase() + p.slice(1).toLowerCase();
    else if (/^([A-Za-z]{2}|\d{3})$/.test(p)) region = p.toUpperCase();
  }
  return { lang, region, script };
}

/** Maps one BCP 47 tag to a supported UI language, or null. */
export function matchLanguage(tag: string): Language | null {
  const { lang, region, script } = canonical(tag);
  if (lang === 'zh') {
    // D-023: by script, then region; Traditional for Hant, TW, HK and MO, else Simplified.
    if (script) return script === 'Hant' ? 'zh-TW' : 'zh-CN';
    return region === 'TW' || region === 'HK' || region === 'MO' ? 'zh-TW' : 'zh-CN';
  }
  if (lang === 'pt') return region === 'BR' || region === null ? 'pt-BR' : null;
  if (lang === 'in') return 'id'; // Legacy tag for Indonesian.
  const hit = SUPPORTED_LANGUAGES.find((l) => l === lang);
  return hit ?? null;
}

/** The first supported language in an Accept-Language header, else English. */
export function languageFromAcceptLanguage(header: string | null | undefined): Language {
  for (const tag of parseAcceptLanguage(header)) {
    const hit = matchLanguage(tag);
    if (hit) return hit;
  }
  return 'en';
}

const EURO_REGIONS = new Set(['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK']);
const REGION_CURRENCY: Record<string, Currency> = {
  GB: 'GBP',
  JP: 'JPY',
  TW: 'TWD',
  HK: 'HKD',
  KR: 'KRW',
  ID: 'IDR',
  TH: 'THB',
  VN: 'VND',
  BR: 'BRL',
};
/** Fallback when the tag has no region (e.g. `ja`). */
const LANGUAGE_CURRENCY: Record<string, Currency> = {
  ja: 'JPY',
  ko: 'KRW',
  id: 'IDR',
  th: 'THB',
  vi: 'VND',
  de: 'EUR',
  fr: 'EUR',
};

/** Display currency for a locale: by region first, then by language, else USD. */
export function currencyForLocale(tag: string): Currency {
  const { lang, region, script } = canonical(tag);
  if (region) {
    if (EURO_REGIONS.has(region)) return 'EUR';
    const byRegion = REGION_CURRENCY[region];
    if (byRegion) return byRegion;
    return 'USD';
  }
  if (lang === 'zh' && script === 'Hant') return 'TWD';
  if (lang === 'pt') return 'BRL';
  return LANGUAGE_CURRENCY[lang] ?? 'USD';
}

/** Defaults for a new user, from the sign-up request's Accept-Language header. */
export function initialPrefs(acceptLanguage: string | null | undefined): Prefs {
  const tags = parseAcceptLanguage(acceptLanguage);
  const first = tags[0];
  return {
    ...DEFAULT_PREFS,
    language: languageFromAcceptLanguage(acceptLanguage),
    currency: first ? currencyForLocale(first) : 'USD',
  };
}

/** Row shape of `user_prefs` (as read with raw D1 or Drizzle without boolean mode). */
export interface PrefsRow {
  language: string;
  currency: string;
  creation_mode: string;
  default_ratio: string;
  default_model: string;
  confirm_threshold: number;
  notifications: string;
  theme: string;
  mature_content: number | boolean;
  /** Migration 0024; absent on rows read before it. */
  enhance_prompt?: number | boolean | null;
  /** Migration 0032 (D-024); absent on rows read before it. */
  review_results?: number | boolean | null;
}

function oneOf<T extends string>(values: readonly T[], v: string, fallback: T): T {
  return (values as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Reads a stored row defensively: unknown stored values fall back to defaults. */
export function prefsFromRow(row: PrefsRow): Prefs {
  let notifications = DEFAULT_NOTIFICATIONS;
  try {
    const parsed = NotificationPrefs.partial().safeParse(JSON.parse(row.notifications));
    if (parsed.success) notifications = { ...DEFAULT_NOTIFICATIONS, ...parsed.data };
  } catch {
    // Keep defaults.
  }
  return {
    language: oneOf(SUPPORTED_LANGUAGES, row.language, 'en'),
    currency: oneOf(SUPPORTED_CURRENCIES, row.currency, 'USD'),
    creationMode: oneOf(CREATION_MODES, row.creation_mode, 'simple'),
    defaultRatio: oneOf(ASPECT_RATIOS, row.default_ratio, '9:16'),
    defaultModel: row.default_model || 'auto',
    confirmThreshold: row.confirm_threshold,
    notifications,
    theme: oneOf(THEMES, row.theme, 'system'),
    matureContent: Boolean(row.mature_content),
    enhancePrompt: row.enhance_prompt === undefined || row.enhance_prompt === null ? DEFAULT_PREFS.enhancePrompt : Boolean(row.enhance_prompt),
    reviewResults: row.review_results === undefined || row.review_results === null ? DEFAULT_PREFS.reviewResults : Boolean(row.review_results),
  };
}

/** Applies a validated patch to the current prefs. */
export function applyPrefsPatch(current: Prefs, patch: PrefsPatch): Prefs {
  return {
    ...current,
    ...patch,
    notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
  } as Prefs;
}
