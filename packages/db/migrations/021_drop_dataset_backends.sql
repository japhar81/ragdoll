-- ADR-0023 step 3: drop the legacy `backends` JSONB column and the
-- `modalities` text[] column from `datasets`. Both were marked
-- @deprecated in migration 020; the unified `bindings` column +
-- runtime resolver are now the only shape.
--
-- Migration 020 already backfilled `bindings` from `backends`; this
-- migration does a defensive re-backfill for any rows added after
-- 020 ran (e.g. in a long-running install where 020 ran weeks ago)
-- so we never drop a column with data the new shape can't see.
--
-- Per-binding namespace policy: the old shape kept `namespace` on
-- the backend block (e.g. `backends.vector.namespace = "by-tenant"`);
-- the new shape moves it onto the binding row itself. Backfill
-- copies it over so the resolver doesn't lose the policy.

-- Defensive re-backfill: any row whose bindings is still NULL or {}
-- and whose backends has rows — translate again. Picks up rows
-- inserted after 020 but before 021.
UPDATE datasets
   SET bindings = (
     SELECT jsonb_object_agg(
       key,
       jsonb_strip_nulls(jsonb_build_object(
         'connection', value -> 'connectionName',
         'collection', value -> 'collection',
         'namespace',  value -> 'namespace'
       ))
     )
     FROM jsonb_each(backends)
   )
 WHERE (bindings IS NULL OR bindings = '{}'::jsonb)
   AND backends IS NOT NULL
   AND backends <> '{}'::jsonb;

-- Defensive merge: rows that ALREADY have bindings but where the
-- legacy backends carried a namespace the new bindings is missing
-- — fold the namespace into the matching binding.
UPDATE datasets d
   SET bindings = (
     SELECT jsonb_object_agg(
       coalesce(bk_key, bn_key),
       coalesce(bn_val, '{}'::jsonb) ||
         jsonb_strip_nulls(jsonb_build_object('namespace', bk_val -> 'namespace'))
     )
     FROM jsonb_each(coalesce(d.bindings, '{}'::jsonb)) bn(bn_key, bn_val)
     FULL JOIN jsonb_each(coalesce(d.backends,  '{}'::jsonb)) bk(bk_key, bk_val)
       ON bn.bn_key = bk.bk_key
   )
 WHERE d.backends IS NOT NULL AND d.backends <> '{}'::jsonb;

-- Drop the legacy columns. The resolver no longer reads them; the
-- API no longer writes them. Audit-log JSON snapshots may still
-- contain the field names in old rows — that's fine, audit rows
-- are immutable and the new screen doesn't render them.
ALTER TABLE datasets DROP COLUMN IF EXISTS backends;
ALTER TABLE datasets DROP COLUMN IF EXISTS modalities;

-- Make bindings authoritative: NOT NULL with empty-object default.
-- (Pre-existing rows that lacked even an empty {} after the
-- backfills above would have been NULL — collapse them.)
UPDATE datasets SET bindings = '{}'::jsonb WHERE bindings IS NULL;
ALTER TABLE datasets ALTER COLUMN bindings SET DEFAULT '{}'::jsonb;
ALTER TABLE datasets ALTER COLUMN bindings SET NOT NULL;
