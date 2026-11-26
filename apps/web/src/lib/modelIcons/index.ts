/**
 * Provider marks for model pickers and model pills (files in
 * `public/model-icons/`, from `@lobehub/icons-static-svg`, MIT; see the README
 * there). Matched by gateway id (`bytedance/seedance-2.5`) or public model id
 * (`claude-…`, `gpt-6-astra`, `deepseek-v4.1-flash`). Models without a public
 * mark (Lumina spicy, swaps, animate) get null and keep their letter tile.
 *
 * Use `<ModelIcon>` to render one; it tints the mono mark with `currentColor`
 * so it reads in both themes.
 */

export type ModelBrand = 'bytedance' | 'minimax' | 'alibaba' | 'qwen' | 'grok' | 'claude' | 'openai' | 'deepseek' | 'zhipu' | 'gemini' | 'doubao';

export interface ModelIconInfo {
  brand: ModelBrand;
  /** Mono mark (fill is the alpha; tint it with a CSS mask). */
  src: string;
  /** Full-color mark, when the brand has one. */
  colorSrc?: string;
  /** Provider name, for `alt` / `aria-label`. */
  alt: string;
}

const BRANDS: Record<ModelBrand, { alt: string; color: boolean }> = {
  bytedance: { alt: 'ByteDance', color: true },
  minimax: { alt: 'MiniMax', color: true },
  alibaba: { alt: 'Alibaba Wan', color: true },
  qwen: { alt: 'Qwen', color: true },
  grok: { alt: 'xAI Grok', color: false },
  claude: { alt: 'Anthropic Claude', color: true },
  openai: { alt: 'OpenAI', color: false },
  deepseek: { alt: 'DeepSeek', color: true },
  zhipu: { alt: 'Zhipu GLM', color: true },
  gemini: { alt: 'Google Gemini', color: true },
  doubao: { alt: 'ByteDance Doubao', color: true },
};

/** Gateway provider prefix (`<provider>/…`) → brand. */
const PROVIDERS: Record<string, ModelBrand> = {
  bytedance: 'bytedance',
  minimax: 'minimax',
  alibaba: 'alibaba',
  wan: 'alibaba',
  qwen: 'qwen',
  xai: 'grok',
  'x-ai': 'grok',
  anthropic: 'claude',
  openai: 'openai',
  deepseek: 'deepseek',
  zhipu: 'zhipu',
  'z-ai': 'zhipu',
  zai: 'zhipu',
  google: 'gemini',
};

/** Model name prefixes (public ids, or the part after the provider) → brand. */
const NAMES: ReadonlyArray<[RegExp, ModelBrand]> = [
  // Seed SC is sold as Doubao; match it before the generic seed- rule.
  [/^(doubao|seed-sc)/, 'doubao'],
  [/^gemini/, 'gemini'],
  [/^(seedance|seedream|seed-)/, 'bytedance'],
  [/^(minimax|hailuo)/, 'minimax'],
  // Lumina Berry 1.0 models are Wan 3.0 (served through the Berry routes).
  [/^(wan|berry-)/, 'alibaba'],
  [/^qwen/, 'qwen'],
  [/^grok/, 'grok'],
  [/^claude/, 'claude'],
  [/^(gpt|o\d|chatgpt|sora)/, 'openai'],
  [/^deepseek/, 'deepseek'],
  [/^(glm|chatglm|cogview|cogvideo)/, 'zhipu'],
];

function info(brand: ModelBrand): ModelIconInfo {
  const b = BRANDS[brand];
  return {
    brand,
    src: `/model-icons/${brand}.svg`,
    colorSrc: b.color ? `/model-icons/${brand}-color.svg` : undefined,
    alt: b.alt,
  };
}

/** The provider mark for a model id, or null to keep the letter tile. */
export function modelIcon(id: string | null | undefined): ModelIconInfo | null {
  if (!id) return null;
  const lower = id.trim().toLowerCase();
  const slash = lower.indexOf('/');
  const provider = slash > 0 ? lower.slice(0, slash) : null;
  const name = slash > 0 ? lower.slice(slash + 1) : lower;
  if (provider === 'lumina') {
    // Only the Berry (Wan 3.0) family has a public mark; spicy, swaps and animate keep the tile.
    return /^berry-/.test(name) ? info('alibaba') : null;
  }
  // ByteDance's Seed SC is sold as Doubao: its own mark, not the ByteDance one.
  if (/^(doubao|seed-sc)/.test(name)) return info('doubao');
  if (provider && PROVIDERS[provider]) return info(PROVIDERS[provider]);
  for (const [re, brand] of NAMES) if (re.test(name)) return info(brand);
  return null;
}

export { ModelIcon, type ModelIconProps } from './ModelIcon';
