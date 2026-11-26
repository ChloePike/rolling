import { isMockApi, mockData } from '@/lib/api/mode';
import type { ImageParams, ResultAction, VideoParams } from './types';

/** Starting settings of the video and image settings popovers (ParamPopover.dc.html defaults). */
export const defaultVideoParams: VideoParams = { aspectRatio: '9:16', resolution: '720p', duration: '5s', count: '1', audio: true };
export const defaultImageParams: ImageParams = { aspectRatio: '9:16', quality: 'standard', size: '2K', count: '1' };

/** Result viewer actions. Costs come from a quote (Regenerate: the run's own cost); mock mode shows the design's numbers. */
export const RESULT_ACTIONS: ResultAction[] = [{ id: 'edit' }, { id: 'regenerate' }, { id: 'extend' }, { id: 'hd' }, { id: 'sendToCanvas' }, { id: 'download' }];

export function resultActions(): ResultAction[] {
  return isMockApi() ? mockData().overlays.mockResultActions : RESULT_ACTIONS;
}
