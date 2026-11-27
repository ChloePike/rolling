import { describe, expect, it } from 'vitest';
import { promptLocale } from './plan';

describe('promptLocale (D-020: spoken lines follow the prompt, not the UI)', () => {
  it('follows the script the prompt is written in', () => {
    expect(promptLocale('一个女孩在雨中奔跑，说：“等等我！”')).toBe('zh-CN');
    expect(promptLocale('雨の中を走る少女が「待って」と言う')).toBe('ja-JP');
    expect(promptLocale('비 오는 거리를 달리는 소녀')).toBe('ko-KR');
    expect(promptLocale('Девушка бежит под дождём')).toBe('ru-RU');
    expect(promptLocale('A girl runs through the rain')).toBeUndefined();
  });

  it('lets a language named in the prompt win over the script', () => {
    expect(promptLocale('一个男人在咖啡馆里说英语，向店员点咖啡')).toBe('en-US');
    expect(promptLocale('两个人用粤语吵架')).toBe('zh-HK');
    expect(promptLocale('A chef explains the recipe in Japanese')).toBe('ja-JP');
    expect(promptLocale('Two friends argue, dialogue in Spanish')).toBe('es-ES');
  });
});
