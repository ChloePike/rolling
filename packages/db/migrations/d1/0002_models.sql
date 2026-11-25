-- Migration 0002_models: model catalog synced from Hyperouter GET /v1/models (D-002).
-- `data` holds the parsed listing model (JSON, technical fields only), `price` its price rules (JSON).
-- `hidden` / `mature` are the overlay flags at sync time; `synced_at` is the last sync that saw the model (epoch ms).
-- Must stay in sync with packages/db/src/d1/schema.ts.

CREATE TABLE models (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('image','video','chat')), data TEXT NOT NULL, price TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, mature INTEGER NOT NULL DEFAULT 0, synced_at INTEGER NOT NULL);
CREATE INDEX models_kind ON models (kind);
CREATE INDEX models_synced ON models (synced_at);
