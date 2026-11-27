/**
 * Enter sends; Shift+Enter inserts a new line. Never while an IME is composing:
 * Chinese, Japanese and Korean input confirm candidates with Enter
 * (`isComposing`, and keyCode 229 in browsers that report the composing key that way).
 */
export function isSendKey(e: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229;
}
