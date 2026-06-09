-- ADR-0023: Dataset.bindings — the new shape that replaces backends.<modality>.*
--
-- The dataset spec was: `backends: { vector: { provider, collection,
-- connectionName, namespace }, text: { ... } }`. Per ADR-0023 §2 it
-- becomes: `bindings: { <free-name>: { connection, collection? } }`.
-- Modality vanishes as a first-class concept; plugin manifests declare
-- the binding NAME they need (and the kind they're compatible with),
-- the dataset wires that name to a (connection, collection) pair.
--
-- Strategy (additive, zero-downtime):
--   1. Add a `bindings` jsonb column. NULL by default for legacy rows.
--   2. Backfill from `backends.<modality>` for existing rows so the
--      cascade resolver sees populated `bindings` immediately — old
--      rows look indistinguishable from new ones to the resolver.
--   3. Leave `backends` + `modalities` columns intact for one release
--      so the legacy resolver path keeps working unchanged. The shim
--      in packages/runtime translates between the two on every resolve.
--
-- Backfill mapping (per modality):
--   backends.<modality>.collection      → bindings.<modality>.collection
--   backends.<modality>.connectionName  → bindings.<modality>.connection
-- Anything else on the legacy block stays accessible via `backends`.

ALTER TABLE datasets
  ADD COLUMN IF NOT EXISTS bindings jsonb;

UPDATE datasets
   SET bindings = (
     SELECT jsonb_object_agg(
       key,
       jsonb_strip_nulls(jsonb_build_object(
         'connection', value -> 'connectionName',
         'collection', value -> 'collection'
       ))
     )
     FROM jsonb_each(backends)
   )
 WHERE bindings IS NULL
   AND backends IS NOT NULL
   AND backends <> '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_datasets_bindings ON datasets USING gin (bindings);
