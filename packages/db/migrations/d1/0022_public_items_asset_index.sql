-- Migration 0022_public_items_asset_index: listAssets (apps/api/src/routes/assets.ts) hides mature public items with
-- `EXISTS (SELECT 1 FROM public_items p WHERE p.asset_id = a.id AND p.mature = 1)`. Without an index on asset_id that
-- subquery scans all of public_items for every candidate asset (8,074 public assets x 5,141 items on staging, ~41M
-- rows per request): one `GET /api/assets?scope=public` took 15.7 s and pushed D1 into "overloaded", so every route
-- answered 500 for ~10 s. With the index the subquery is a single lookup.
CREATE INDEX IF NOT EXISTS public_items_asset ON public_items (asset_id, mature);
