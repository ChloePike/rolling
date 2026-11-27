import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { englishMessages } from '@/i18n/messages';
import { RunConfirmPanel } from './RunConfirm';
import type { RunPlanRow } from './types';

const html = (node: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={englishMessages}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );

const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const ROW: RunPlanRow = { id: 'n1', name: 'Keyframe', meta: 'Seedream 5.0 Flash', kind: 'image', state: 'run', cost: 7 };

describe('Run all dialog while the quote loads (canvas)', () => {
  it('shows skeletons and a disabled Run, never zeros', () => {
    const out = html(<RunConfirmPanel variant="graph" rows={[]} balance={0} eta="~4 min" loading onConfirm={() => {}} onCancel={() => {}} />);
    expect(out).toContain('data-skeleton');
    expect(out).toContain('run-confirm-row-skeleton');
    const t = text(out);
    expect(t).not.toContain('0 to generate');
    expect(t).not.toMatch(/(^|\s)0 credits/);
    expect(t).not.toContain('Run · 0');
    expect(t).toContain('Getting price…');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*aria-busy="true"/);
  });

  it('shows the quote once it is back', () => {
    const t = text(html(<RunConfirmPanel variant="graph" rows={[ROW]} balance={100} eta="~4 min" onConfirm={() => {}} onCancel={() => {}} />));
    expect(t).toContain('1 to generate');
    expect(t).toContain('Run · 7 credits');
    expect(t).not.toContain('Getting price');
  });
});

/** Renders inside a memory router (the picker's footer is a router Link). */
async function inRouter(node: ReactNode): Promise<string> {
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const router = createRouter({ routeTree: createRootRoute({ component: () => <>{node}</> }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return html(<RouterProvider router={router} />);
}

describe('Model picker while the catalog loads', () => {
  it('shows skeleton rows, not “No models match “””', async () => {
    const { ModelPicker } = await import('./ModelPicker');
    const out = await inRouter(<ModelPicker kind="image" value="auto" onValueChange={() => {}} models={[]} loading />);
    expect(out).toContain('model-picker-skeleton');
    expect(text(out)).not.toContain('No models match');
  });

  it('says no models match once loaded and a search finds nothing', async () => {
    const { ModelPicker } = await import('./ModelPicker');
    const out = await inRouter(<ModelPicker kind="image" value="auto" onValueChange={() => {}} models={[]} />);
    expect(out).not.toContain('model-picker-skeleton');
    expect(text(out)).toContain('No models match');
  });
});
