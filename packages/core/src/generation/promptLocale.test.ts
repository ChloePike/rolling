import { describe, expect, it } from 'vitest';
import { latinPromptLocale, promptLocale } from './plan';

describe('promptLocale (D-020: the output follows the prompt, not the UI)', () => {
  it('follows the script the prompt is written in', () => {
    expect(promptLocale('一个女孩在雨中奔跑，说：“等等我！”')).toBe('zh-CN');
    expect(promptLocale('雨の中を走る少女が「待って」と言う')).toBe('ja-JP');
    expect(promptLocale('비 오는 거리를 달리는 소녀')).toBe('ko-KR');
    expect(promptLocale('Девушка бежит под дождём')).toBe('ru-RU');
  });

  it('lets a language named in the prompt win over the script', () => {
    expect(promptLocale('一个男人在咖啡馆里说英语，向店员点咖啡')).toBe('en-US');
    expect(promptLocale('两个人用粤语吵架')).toBe('zh-HK');
    expect(promptLocale('A chef explains the recipe in Japanese')).toBe('ja-JP');
    expect(promptLocale('Two friends argue, dialogue in Spanish')).toBe('es-ES');
    expect(promptLocale('Una donna parla in English al telefono')).toBe('en-US');
    expect(promptLocale('A tour guide speaking Italian in Rome')).toBe('it-IT');
  });

  it('tells apart English, Spanish, French, German, Portuguese and Italian prompts (GEN-4)', () => {
    expect(promptLocale('A girl runs through the rain')).toBe('en-US');
    expect(promptLocale('Golden hour portrait of a woman wearing a red coat')).toBe('en-US');
    expect(promptLocale('Una chica corre bajo la lluvia')).toBe('es-ES');
    expect(promptLocale('El perro juega con una pelota en el parque')).toBe('es-ES');
    expect(promptLocale('Un homme marche sous la pluie avec son chien')).toBe('fr-FR');
    expect(promptLocale('Ein Mann geht im Regen durch die Stadt')).toBe('de-DE');
    expect(promptLocale('Uma mulher caminha na chuva com o seu cão')).toBe('pt-BR');
    expect(promptLocale('Una ragazza cammina sotto la pioggia nella città')).toBe('it-IT');
  });

  it('defaults Latin-script prompts to English when nothing is clear', () => {
    expect(promptLocale('a red bicycle')).toBe('en-US');
    expect(promptLocale('neon, cyberpunk, 35mm')).toBe('en-US');
    expect(promptLocale('Café de Flore, Paris')).toBe('en-US');
    // Shared words only (la, una): no clear winner between Spanish and Italian.
    expect(latinPromptLocale('una la')).toBe('en-US');
    expect(promptLocale('Portrait in the style of de Chirico')).toBe('en-US');
  });

  it('returns nothing for prompts without letters', () => {
    expect(promptLocale('1234 !!')).toBeUndefined();
    expect(promptLocale('')).toBeUndefined();
  });
});
