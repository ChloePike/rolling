import { useMemo } from 'react';
import { useIntl } from 'react-intl';
import type { PromptCommand, PromptCommandGroup } from './types';

/** Built-in action command ids. Hosts handle them in `PromptBox.onCommand`. */
export const COMMAND = {
  storyboard: 'cmd_storyboard',
  character: 'cmd_character',
  voice: 'cmd_voice',
  canvas: 'cmd_canvas',
  model: 'cmd_model',
  aspect: 'cmd_aspect',
  duration: 'cmd_duration',
  clear: 'cmd_clear',
} as const;

/**
 * The `/` palette groups from Main.dc.html: Skills, Create, Settings.
 * `pillIds` maps the Model / Aspect ratio / Duration commands to the host's pills.
 */
export function useDefaultCommandGroups(
  skills: PromptCommand[],
  pillIds: { model?: string; aspect?: string; duration?: string } = {},
): PromptCommandGroup[] {
  const intl = useIntl();
  return useMemo(() => {
    const t = (id: string) => intl.formatMessage({ id });
    const action = (key: string, id: string, icon: PromptCommand['icon'], pillId?: string): PromptCommand => ({
      id,
      name: t(`prompt.cmd.${key}`),
      description: t(`prompt.cmd.${key}.desc`),
      icon,
      kind: 'action',
      pillId,
    });
    return [
      { id: 'skills', title: t('prompt.palette.group.skills'), items: skills },
      {
        id: 'create',
        title: t('prompt.palette.group.create'),
        items: [
          action('storyboard', COMMAND.storyboard, 'film'),
          action('character', COMMAND.character, 'person'),
          action('voice', COMMAND.voice, 'wave'),
          action('canvas', COMMAND.canvas, 'frame'),
        ],
      },
      {
        id: 'settings',
        title: t('prompt.palette.group.settings'),
        items: [
          action('model', COMMAND.model, 'cube', pillIds.model),
          action('aspect', COMMAND.aspect, 'ratio', pillIds.aspect),
          action('duration', COMMAND.duration, 'clock', pillIds.duration),
          action('clear', COMMAND.clear, 'trash'),
        ],
      },
    ];
  }, [intl, skills, pillIds.model, pillIds.aspect, pillIds.duration]);
}

/** True when the prompt opens the `/` palette: it starts with `/` and has no space yet (handoff 4). */
export function isSlashQuery(text: string): boolean {
  return text.startsWith('/') && !/\s/.test(text);
}

/** Filters groups by the text after `/`, matching name or description; drops empty groups. */
export function filterCommands(groups: PromptCommandGroup[], query: string): PromptCommandGroup[] {
  const q = query.toLowerCase();
  return groups
    .map((g) => ({
      ...g,
      items: g.items.filter((c) => !q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)),
    }))
    .filter((g) => g.items.length > 0);
}

/** Matches an `@query` at the end of the prompt. Returns the query (possibly empty) or null. */
export function trailingAtQuery(text: string): string | null {
  const m = /@([^\s@]*)$/.exec(text);
  return m ? m[1]! : null;
}

export function stripTrailingAt(text: string): string {
  return text.replace(/@[^\s@]*$/, '');
}
