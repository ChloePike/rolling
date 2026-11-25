/** Per-browser conveniences for the canvas (wrapped: storage can be blocked or empty). */
export function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* Storage unavailable: the choice lasts until reload. */
  }
}
