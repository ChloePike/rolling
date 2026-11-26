import { describe, expect, it } from 'vitest';
import { modelIcon } from './index';

describe('modelIcon', () => {
  it.each([
    ['bytedance/seedance-2.5', 'bytedance'],
    ['bytedance/seedream-5.0-lite', 'bytedance'],
    ['minimax/minimax-h3', 'minimax'],
    ['alibaba/wan3.0', 'alibaba'],
    ['lumina/berry-1.0-pro-turbo', 'alibaba'],
    ['qwen/qwen-image-2.0', 'qwen'],
    ['xai/grok-4.6', 'grok'],
    ['grok-4.6', 'grok'],
    ['anthropic/claude-sonnet-5', 'claude'],
    ['claude-opus-5', 'claude'],
    ['gpt-6-astra', 'openai'],
    ['gpt-6.1-sol', 'openai'],
    ['deepseek/deepseek-v4.1-flash', 'deepseek'],
    ['deepseek-v4.1-flash-1017', 'deepseek'],
    ['glm-5.3', 'zhipu'],
    ['zhipu/glm-5.3', 'zhipu'],
  ])('%s → %s', (id, brand) => {
    const icon = modelIcon(id);
    expect(icon?.brand).toBe(brand);
    expect(icon?.src).toBe(`/model-icons/${brand}.svg`);
  });

  it('keeps the letter tile for Lumina models without a public mark and unknown ids', () => {
    expect(modelIcon('lumina/wan2.7-i2v-spicy')).toBeNull();
    expect(modelIcon('lumina/minimax-h3-lipsync')).toBeNull();
    expect(modelIcon('lumina/face-swap')).toBeNull();
    expect(modelIcon('auto')).toBeNull();
    expect(modelIcon('')).toBeNull();
  });

  it('has a color file only where the package ships one', () => {
    expect(modelIcon('gpt-6-astra')?.colorSrc).toBeUndefined();
    expect(modelIcon('claude-opus-5')?.colorSrc).toBe('/model-icons/claude-color.svg');
  });
  it('marks Gemini and Doubao (Seed SC) with their own brands', () => {
    expect(modelIcon('google/gemini-4-argon')?.brand).toBe('gemini');
    expect(modelIcon('gemini-4-hydrogen')?.brand).toBe('gemini');
    expect(modelIcon('bytedance/seed-sc-260628')?.brand).toBe('doubao');
    expect(modelIcon('doubao')?.brand).toBe('doubao');
    expect(modelIcon('bytedance/seedance-2.5')?.brand).toBe('bytedance');
  });
});
