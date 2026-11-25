import { useMemo } from 'react';
import { pickerModels, useModels, type CatalogModel } from '@/lib/models';
import { ratesFrom, type Rates } from './equivalents';

/** Shot and image equivalents from the synced catalog (falls back to the D-006 example). */
export function useRates(): Rates {
  const video = useModels('video');
  const image = useModels('image');
  return useMemo(() => ratesFrom(video.data, image.data), [video.data, image.data]);
}

/** Featured video and image models (D-009 curated list), for the "same models on every plan" row. */
export function useFeaturedModels(): CatalogModel[] {
  const video = useModels('video');
  const image = useModels('image');
  return useMemo(
    () => [...pickerModels(video.data, { featuredOnly: true }), ...pickerModels(image.data, { featuredOnly: true })].filter((m) => !m.matureOnly && !m.mature),
    [video.data, image.data],
  );
}
