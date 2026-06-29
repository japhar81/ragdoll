-- 026_deployment_unique_nulls_not_distinct.sql
--
-- issues-log #6: Builder "Deploy" reports success but the run still
-- executes the PREVIOUS version, and a global redeploy appears to leave
-- the old deployment in place.
--
-- Root cause: `pipeline_deployments` has UNIQUE (pipeline_id,
-- environment, tenant_id) (001_initial_schema.sql), but a plain UNIQUE
-- treats NULLs as DISTINCT. A GLOBAL deployment has tenant_id IS NULL,
-- so (pipe, env, NULL) never conflicts with another (pipe, env, NULL).
-- Consequences:
--   * `upsertActive`'s `ON CONFLICT (pipeline_id, environment,
--     tenant_id)` never fires for global deploys → every redeploy
--     INSERTs a brand-new active row instead of swapping the version in
--     place.
--   * `getActiveDeployment` (... LIMIT 1, no ORDER BY) then returns an
--     arbitrary one of the now-multiple active rows — frequently the
--     STALE one — so the run resolves the old pipeline_version_id even
--     though Deploy "succeeded".
--
-- Fix: rebuild the constraint as UNIQUE NULLS NOT DISTINCT (Postgres
-- 15+, and we run pg16) so a NULL tenant_id participates in uniqueness
-- like any other value. The ON CONFLICT inference in upsertActive then
-- correctly UPDATEs the single global row in place. A matching
-- ORDER BY deployed_at DESC in getActiveDeployment (see
-- packages/db/src/postgres/pipelines.ts) defends determinism even if a
-- row pair slips through.
--
-- Before swapping the constraint we must collapse any duplicate active
-- rows that the old (broken) constraint already let in, otherwise the
-- stricter constraint can't be created. We keep the most recently
-- deployed row per (pipeline_id, environment, tenant_id) — window
-- PARTITION BY groups NULL tenant_ids together (unlike the old UNIQUE),
-- so this is exactly the set the new constraint will enforce.

DELETE FROM pipeline_deployments d
USING (
  SELECT id,
         row_number() OVER (
           PARTITION BY pipeline_id, environment, tenant_id
           ORDER BY deployed_at DESC, id DESC
         ) AS rn
    FROM pipeline_deployments
) ranked
WHERE d.id = ranked.id
  AND ranked.rn > 1;

-- Drop EVERY existing UNIQUE constraint on exactly (pipeline_id,
-- environment, tenant_id) — the inline one from 001 is auto-named
-- (…_pipeline_id_environment_tenant_id_key), and we also clear our own
-- replacement name so a re-run can't leave two unique indexes on the
-- same columns (which makes ON CONFLICT inference ambiguous). The
-- catalog lookup avoids hard-coding the auto-generated name.
DO $$
DECLARE
  c text;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname = 'pipeline_deployments'
       AND con.contype = 'u'
       -- columns {pipeline_id, environment, tenant_id} in any order
       AND (
         SELECT array_agg(att.attname::text ORDER BY att.attname)
           FROM unnest(con.conkey) AS k(attnum)
           JOIN pg_attribute att
             ON att.attrelid = con.conrelid AND att.attnum = k.attnum
       ) = ARRAY['environment', 'pipeline_id', 'tenant_id']
  LOOP
    EXECUTE format(
      'ALTER TABLE pipeline_deployments DROP CONSTRAINT %I', c
    );
  END LOOP;
END $$;

ALTER TABLE pipeline_deployments
  ADD CONSTRAINT pipeline_deployments_pipeline_env_tenant_key
  UNIQUE NULLS NOT DISTINCT (pipeline_id, environment, tenant_id);
