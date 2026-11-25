/** ModelsPort over a merged catalog (the Worker loads it from the synced D1 rows). */
import type { Catalog } from '@rolling/core';
import { creditsFor } from '@rolling/core/pricing/config';
import type { ModelsPort } from './ports';

export function catalogModelsPort(catalog: Catalog): ModelsPort {
  return {
    models: () => catalog.models.filter((m) => m.kind !== 'chat'),
    get: (id) => {
      const m = catalog.get(id);
      return m && m.kind !== 'chat' ? m : undefined;
    },
    creditsFor: (model, request) => {
      try {
        return creditsFor(model, request);
      } catch {
        return null;
      }
    },
    chatModels: () => catalog.models.filter((m) => m.kind === 'chat'),
  };
}

