/** Test helper: the catalog built from the trimmed real listing fixture (GET /v1/models, 2026-11-25). */
import { Catalog } from '../catalog';
import type { CatalogModel } from '../types';
import listing from './hyperouter-models.json';

export const fixtureListing: unknown = listing;
export const fixtureCatalog: Catalog = Catalog.fromListing(listing).catalog;

/** A fixture model by gateway id; throws when it is missing. */
export function fixtureModel(id: string): CatalogModel {
  const m = fixtureCatalog.get(id);
  if (!m) throw new Error(`Fixture has no model ${id}`);
  return m;
}
