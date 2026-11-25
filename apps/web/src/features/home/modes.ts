import type { PromptIconName } from '@/features/prompt';

export type HomeModeId = 'agent' | 'image' | 'video' | 'avatar';

/** The four modes of the Home prompt box (Main.dc.html `M`). Pills are built in `usePromptPills`. */
export const HOME_MODES: Array<{ id: HomeModeId; icon: PromptIconName }> = [
  { id: 'agent', icon: 'spark' },
  { id: 'image', icon: 'image' },
  { id: 'video', icon: 'video' },
  { id: 'avatar', icon: 'person' },
];

/** Static choices for pills that are not models or generation settings. */
export const FRAME_MODES = ['firstFrame', 'firstLastFrame', 'omniReference'] as const;
export const PERSONAS = ['Product advisor', 'Mia', 'Leo'];
export const VOICES = ['Clear female', 'Steady male', 'My voice 01'];
