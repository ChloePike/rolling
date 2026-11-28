import { describe, expect, it } from 'vitest';
import { replyLanguage } from '../src/context';

describe('reply language (D-023: the message, never the UI language)', () => {
  it('follows the language the user writes in', () => {
    expect(replyLanguage('我想做一个熊打飞机的搞笑视频', [], 'en-US')).toBe('zh-CN');
    expect(replyLanguage('猫がピアノを弾く動画を作って', [], 'zh-CN')).toBe('ja-JP');
    expect(replyLanguage('Make a 15 second ad for my coffee shop', [], 'zh-CN')).toBe('en-US');
  });
  it('ignores a language the brief names for the video', () => {
    expect(replyLanguage('做一个英文广告，15秒', [], 'en-US')).toBe('zh-CN');
  });
  it('keeps the thread language for a short or wordless reply, else the UI language', () => {
    expect(replyLanguage('ok', ['我想做一个熊打飞机的搞笑视频'], 'en-US')).toBe('zh-CN');
    expect(replyLanguage('2', ['我想做一个熊打飞机的搞笑视频'], 'en-US')).toBe('zh-CN');
    expect(replyLanguage('42', [], 'ko-KR')).toBe('ko-KR');
  });
});
