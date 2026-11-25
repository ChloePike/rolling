import type { Page } from '@playwright/test';

export type Crop = 'body' | 'full';

export interface ToolState {
  /** e.g. `quick-advanced`. */
  id: string;
  tool: 'quick' | 'remix' | 'avatar' | 'character';
  /** Design wrapper or base file (without `.dc.html`). */
  design: string;
  path: string;
  mode: 'simple' | 'advanced';
  /** Opens the state in the app after load. */
  open?: (page: Page) => Promise<void>;
  /**
   * `body`: compare the area under the header (the tool designs draw a 68px
   * header, the shared app header is 72px, see the report). `full`: compare
   * the whole viewport (modal states cover the header).
   */
  crop: Crop;
}

const clickModel = (page: Page) => page.locator('[data-pill="model"]').click();
const clickParams = (page: Page) => page.locator('[data-pill]').nth(1).click();
const clickSend = (page: Page) => page.getByTestId('tool-composer').locator('button[title]').last().click();
/** Real pointer click: locator.click() would scroll the feed to bring the card into view first. */
const clickResult = async (page: Page) => {
  const b = (await page.locator('article button[aria-label="Details"]').nth(1).boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
};

export const TOOL_STATES: ToolState[] = [
  { id: 'quick-simple', tool: 'quick', design: 'QuickCreate', path: '/create/quick', mode: 'simple', crop: 'body' },
  { id: 'quick-advanced', tool: 'quick', design: 'QuickCreateAdv', path: '/create/quick', mode: 'advanced', crop: 'body' },
  { id: 'quick-model', tool: 'quick', design: 'QuickCreateModel', path: '/create/quick', mode: 'simple', open: clickModel, crop: 'body' },
  { id: 'quick-params', tool: 'quick', design: 'QuickCreateParams', path: '/create/quick', mode: 'simple', open: clickParams, crop: 'body' },
  { id: 'quick-confirm', tool: 'quick', design: 'QuickCreateConfirm', path: '/create/quick', mode: 'simple', open: clickSend, crop: 'full' },
  { id: 'quick-viewer', tool: 'quick', design: 'QuickCreateViewer', path: '/create/quick', mode: 'simple', open: clickResult, crop: 'full' },
  { id: 'remix-simple', tool: 'remix', design: 'OriginalVideo', path: '/create/remix', mode: 'simple', crop: 'body' },
  { id: 'remix-advanced', tool: 'remix', design: 'OriginalVideoAdv', path: '/create/remix', mode: 'advanced', crop: 'body' },
  { id: 'avatar-simple', tool: 'avatar', design: 'DigitalHuman', path: '/create/avatar', mode: 'simple', crop: 'body' },
  { id: 'avatar-advanced', tool: 'avatar', design: 'DigitalHumanAdv', path: '/create/avatar', mode: 'advanced', crop: 'body' },
  { id: 'avatar-model', tool: 'avatar', design: 'DigitalHumanModel', path: '/create/avatar', mode: 'advanced', open: clickModel, crop: 'body' },
  { id: 'character-simple', tool: 'character', design: 'Character', path: '/create/character', mode: 'simple', crop: 'body' },
  { id: 'character-advanced', tool: 'character', design: 'CharacterAdv', path: '/create/character', mode: 'advanced', crop: 'body' },
  { id: 'character-params', tool: 'character', design: 'CharacterParams', path: '/create/character', mode: 'simple', open: clickParams, crop: 'body' },
];

export const DESIGN_HEADER = 68;
export const APP_HEADER = 72;
export const WIDTH = 1440;
export const HEIGHT = 900;
