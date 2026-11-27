import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * Post-production in the editor (D-033 .. D-037), mock mode (/dev/editor):
 * auto captions with a look, caption files, export presets in a batch,
 * Smoother motion with a preview, the brand kit, extend clip, reframing,
 * ducking and the imported voiceover with its rights note.
 */

async function openEditor(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dev/editor');
  await page.locator('[data-testid="editor"][data-shown="true"]').waitFor();
}

async function effects(page: Page) {
  await page.getByRole('button', { name: 'Effects' }).click();
  return page.getByRole('menu', { name: 'Effects' });
}

test.describe('post-production', () => {
  test('auto captions: a look, then the captions show in that look and download as SRT and WebVTT', async ({ page }) => {
    await openEditor(page);
    await (await effects(page)).getByRole('menuitem', { name: 'Auto captions…' }).click();
    const dialog = page.getByTestId('captions-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('radio', { name: 'Bold social' }).click();
    await expect(dialog.getByText('Big, short lines with an outline', { exact: false })).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Language' })).toHaveValue('auto');
    await dialog.getByRole('button', { name: 'Make captions' }).click();
    await expect(page.getByText(/Added 2 captions · English/)).toBeVisible();
    // The monitor previews the chosen look (bold, a larger size than the default caption).
    const caption = page.getByTestId('monitor-caption');
    await expect(caption).toBeVisible();
    await expect(caption).toHaveCSS('font-weight', '800');
    // The caption look is a track setting: change it without transcribing again.
    await (await effects(page)).getByRole('menuitem', { name: 'Auto captions…' }).click();
    await expect(dialog.getByRole('radio', { name: 'Bold social' })).toHaveAttribute('aria-checked', 'true');
    await dialog.getByRole('radio', { name: 'Minimal' }).click();
    await dialog.getByRole('button', { name: 'Apply look only' }).click();
    await expect(caption).toHaveCSS('font-weight', '400');
    await (await effects(page)).getByRole('menuitem', { name: 'Auto captions…' }).click();
    for (const [name, ext, head] of [['Download captions (SRT)', '.srt', /^1\n00:00:00,400 --> /], ['Download captions (WebVTT)', '.vtt', /^WEBVTT\nLanguage: en\n\n/]] as const) {
      const wait = page.waitForEvent('download');
      await dialog.getByRole('button', { name }).click();
      const file = await wait;
      expect(file.suggestedFilename().endsWith(ext)).toBe(true);
      expect(readFileSync((await file.path())!, 'utf8')).toMatch(head);
    }
  });

  test('export: social presets in one batch, honest Smoother motion with a preview, caption files', async ({ page }) => {
    await openEditor(page);
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const dialog = page.getByTestId('export-dialog');
    const presets = dialog.getByTestId('export-presets');
    await expect(presets.getByText('1080 × 1920').first()).toBeVisible();
    await presets.getByLabel(/TikTok, Reels, Shorts · 9:16/).check();
    await presets.getByLabel(/YouTube · 16:9/).check();
    await expect(dialog.getByText(/crop each shot around its subject/)).toBeVisible();
    await expect(dialog.getByText(/−14 LUFS/)).toBeVisible();
    await dialog.getByRole('radio', { name: '60 fps' }).click();
    await expect(dialog.getByText(/Adds in-between frames by estimating motion/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Preview 4s' }).click();
    await expect(dialog.getByTestId('smooth-preview')).toBeVisible({ timeout: 5000 });
    await expect(dialog.getByText(/60 fps\. Exports are free\./)).toBeVisible();
    await dialog.getByRole('button', { name: 'Export 3 files' }).click();
    await expect(dialog).toHaveAttribute('data-phase', 'done', { timeout: 8000 });
    await expect(dialog.getByRole('link', { name: 'Download' })).toHaveCount(3);
  });

  test('brand kit: colors, a font with its license note, watermark and an end card', async ({ page }) => {
    await openEditor(page);
    await (await effects(page)).getByRole('menuitem', { name: 'Brand kit…' }).click();
    const dialog = page.getByTestId('brand-kit-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Add color' }).click();
    await expect(dialog.getByRole('button', { name: 'Remove #3B82F6' })).toBeVisible();
    const upload = dialog.getByRole('button', { name: 'Upload font' });
    await expect(upload).toBeDisabled();
    await dialog.getByLabel('I have a license that allows this font in videos I publish').check();
    await dialog.getByTestId('brand-font-file').setInputFiles({ name: 'Inter-Bold.woff2', mimeType: 'font/woff2', buffer: Buffer.from('wOF2fake') });
    await expect(dialog.getByRole('button', { name: 'Remove Inter Bold' })).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Caption font' }).selectOption({ label: 'Inter Bold' });
    await dialog.getByRole('switch', { name: 'Logo watermark' }).click();
    await dialog.getByRole('radio', { name: 'Top left' }).click();
    await dialog.getByRole('switch', { name: 'End card' }).click();
    await dialog.getByRole('textbox', { name: 'Card text' }).fill('See you Sunday');
    await dialog.getByRole('button', { name: 'Save brand kit' }).click();
    await expect(page.getByText('Brand kit saved')).toBeVisible();
    // The export dialog now offers to apply it (an end card is set).
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(page.getByTestId('export-dialog').getByRole('switch', { name: 'Apply brand kit' })).toBeEnabled();
  });

  test('extend clip, reframing and ducking from Effects', async ({ page }) => {
    await openEditor(page);
    await (await effects(page)).getByRole('menuitem', { name: 'Reframe for other sizes…' }).click();
    const reframe = page.getByTestId('reframe-dialog');
    await expect(reframe.getByRole('radio', { name: 'Follow the subject' })).toHaveAttribute('aria-checked', 'true');
    await reframe.getByRole('radio', { name: 'Fixed point' }).click();
    await expect(reframe.getByRole('slider', { name: 'Point to keep, left to right' })).toBeVisible();
    await reframe.getByRole('button', { name: 'Close' }).last().click();
    await (await effects(page)).getByRole('menuitem', { name: 'Reframe for other sizes…' }).click();
    await expect(reframe.getByRole('radio', { name: 'Fixed point' })).toHaveAttribute('aria-checked', 'true');
    await reframe.getByRole('button', { name: 'Close' }).last().click();
    const menu = await effects(page);
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Duck under the voiceover' })).toBeDisabled();
    await menu.getByRole('menuitem', { name: 'Extend clip…' }).click();
    const dialog = page.getByTestId('extend-dialog');
    await expect(dialog.getByText('Continues this shot from its last frame')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'See price' })).toBeDisabled();
    await dialog.getByRole('textbox', { name: 'What happens next' }).fill('The can tips over and fizzes');
    await dialog.getByRole('radio', { name: '8s' }).click();
    await dialog.getByRole('button', { name: 'See price' }).click();
    await expect(dialog).toHaveCount(0);
    // The mock run (below the confirm threshold) starts and reports through the shared run flow.
    await expect(page.getByText(/Extend clip/).first()).toBeVisible();
  });

  test('import voiceover needs the rights note, then lands on the voice lane', async ({ page }) => {
    await openEditor(page);
    await (await effects(page)).getByRole('menuitem', { name: 'Import voiceover…' }).click();
    const dialog = page.getByTestId('voiceover-dialog');
    await expect(dialog.getByRole('button', { name: 'Choose file' })).toBeDisabled();
    await dialog.getByTestId('voice-rights').check();
    await expect(dialog.getByRole('button', { name: 'Choose file' })).toBeEnabled();
    await dialog.getByTestId('voiceover-file').setInputFiles({ name: 'vo.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from([0x49, 0x44, 0x33, 3, 0, 0]) });
    await expect(page.getByText('Voiceover added to the voice lane')).toBeVisible();
    // The new clip is selected on the voice lane; with a voice clip selected, Lip-sync needs a shot.
    await expect(page.getByRole('complementary', { name: 'Inspector' }).getByText('Voiceover').first()).toBeVisible();
    await page.getByRole('button', { name: 'Effects' }).click();
    await expect(page.getByRole('menu', { name: 'Effects' }).getByRole('menuitem', { name: 'Lip-sync to voice…' })).toBeDisabled();
  });
});
