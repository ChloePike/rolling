import type { Page } from '@playwright/test';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HeaderParts {
  header: string;
  logo: string;
  wordmark: string;
  nav: string;
  navItems: string;
  credits: string;
  upgrade: string;
  settings: string;
  account: string;
}

/** Selectors for the app header. */
export const APP_PARTS: HeaderParts = {
  header: '[data-testid="app-header"]',
  logo: '[data-testid="app-header"] > div:first-child svg',
  wordmark: '[data-testid="app-header"] > div:first-child a > span',
  nav: 'nav[aria-label="Main"]',
  navItems: 'nav[aria-label="Main"] a',
  credits: 'button[aria-label^="Credit balance"]',
  upgrade: '[data-testid="app-header"] a[href="/upgrade"]',
  settings: 'button[aria-label="Settings"]',
  account: 'button[aria-label="Account"]',
};

/** Selectors for the header in the rendered Main.dc.html. */
export const DESIGN_PARTS: HeaderParts = {
  header: 'header',
  logo: 'header > div:first-child svg',
  wordmark: 'header > div:first-child span',
  nav: 'nav[aria-label="Main"]',
  navItems: 'nav[aria-label="Main"] a',
  credits: 'button[aria-label="Credit balance"]',
  upgrade: 'header > div:nth-of-type(2) > a',
  settings: 'button[aria-label="Settings"]',
  account: 'button[aria-label="Account"]',
};

export interface Measured {
  box: Box;
  background: string;
  color: string;
  fill?: string;
}

export type HeaderMeasurements = Record<Exclude<keyof HeaderParts, 'navItems'>, Measured> & {
  navItems: Array<Measured & { text: string }>;
  viewportWidth: number;
};

export async function measureHeader(page: Page, parts: HeaderParts): Promise<HeaderMeasurements> {
  return page.evaluate((p) => {
    const read = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const circle = el.querySelector('circle');
      return {
        box: { x: r.x, y: r.y, width: r.width, height: r.height },
        background: cs.backgroundColor,
        color: cs.color,
        fill: circle ? getComputedStyle(circle).fill : undefined,
      };
    };
    const one = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`Missing ${sel}`);
      return read(el);
    };
    return {
      header: one(p.header),
      logo: one(p.logo),
      wordmark: one(p.wordmark),
      nav: one(p.nav),
      navItems: Array.from(document.querySelectorAll(p.navItems)).map((el) => ({
        ...read(el),
        text: (el.textContent ?? '').trim(),
      })),
      credits: one(p.credits),
      upgrade: one(p.upgrade),
      settings: one(p.settings),
      account: one(p.account),
      viewportWidth: window.innerWidth,
    };
  }, parts);
}

/** Compares two PNGs in the browser; returns the fraction of pixels that differ noticeably. */
export async function pixelDiffRatio(page: Page, a: Buffer, b: Buffer, channelTolerance = 24): Promise<number> {
  return page.evaluate(
    async ({ a, b, tol }) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = src;
        });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const w = Math.min(ia.width, ib.width);
      const h = Math.min(ia.height, ib.height);
      const pixels = (img: HTMLImageElement) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, w, h).data;
      };
      const pa = pixels(ia);
      const pb = pixels(ib);
      let diff = 0;
      for (let i = 0; i < pa.length; i += 4) {
        if (
          Math.abs(pa[i]! - pb[i]!) > tol ||
          Math.abs(pa[i + 1]! - pb[i + 1]!) > tol ||
          Math.abs(pa[i + 2]! - pb[i + 2]!) > tol
        )
          diff++;
      }
      return diff / (w * h);
    },
    {
      a: `data:image/png;base64,${a.toString('base64')}`,
      b: `data:image/png;base64,${b.toString('base64')}`,
      tol: channelTolerance,
    },
  );
}
