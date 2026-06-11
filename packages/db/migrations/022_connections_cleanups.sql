-- 022_connections_cleanups.sql
--
-- Two related fixes against the unified `connections` table that
-- bulwark's ingestion stack stumbled into.
--
-- 1) `connections.secret_ref_id` was declared `uuid` but the runtime
--    always resolved it as a logical key (`secret_refs.logical_key`).
--    Forcing operators to put a UUID into the secret's logical_key
--    was confusing — fix by renaming the column to `secret_ref_key`
--    and changing its type to `text`. Existing values are preserved
--    (UUIDs serialize cleanly into text).
--
-- 2) The partial unique slug indexes (slug_global / slug_tenant /
--    slug_environment) did NOT exclude archived rows. Soft-archiving
--    a connection (the default DELETE without ?force) reserved the
--    slug forever — re-creating the same slug failed
--    `409 duplicate key connections_slug_global` until someone hard-
--    deleted the ghost. Recreate the indexes with `AND archived_at
--    IS NULL` so an archived slug becomes reusable.
--
-- Apply the same archive-aware fix to the `datasets` table — same
-- partial-unique shape, same ghost-slug risk.

BEGIN;

-- --- (1) connections.secret_ref_id → connections.secret_ref_key (text) ---

ALTER TABLE connections
  RENAME COLUMN secret_ref_id TO secret_ref_key;

ALTER TABLE connections
  ALTER COLUMN secret_ref_key TYPE text USING secret_ref_key::text;

COMMENT ON COLUMN connections.secret_ref_key IS
  'Logical key of the managed secret backing this connection. Resolved against secret_refs.logical_key; null when the connection has no credential (no-auth backends).';

-- --- (2) connections partial-unique indexes exclude archived rows ---

DROP INDEX IF EXISTS connections_slug_global;
DROP INDEX IF EXISTS connections_slug_tenant;
DROP INDEX IF EXISTS connections_slug_environment;

CREATE UNIQUE INDEX connections_slug_global
  ON connections (slug)
  WHERE scope = 'global' AND archived_at IS NULL;
CREATE UNIQUE INDEX connections_slug_tenant
  ON connections (tenant_id, slug)
  WHERE scope = 'tenant' AND archived_at IS NULL;
CREATE UNIQUE INDEX connections_slug_environment
  ON connections (tenant_id, environment_id, slug)
  WHERE scope = 'environment' AND archived_at IS NULL;

-- --- same archive-aware fix on datasets (same shape, same risk) ---

DROP INDEX IF EXISTS datasets_slug_global;
DROP INDEX IF EXISTS datasets_slug_tenant;
DROP INDEX IF EXISTS datasets_slug_environment;

CREATE UNIQUE INDEX datasets_slug_global
  ON datasets (slug)
  WHERE scope = 'global' AND archived_at IS NULL;
CREATE UNIQUE INDEX datasets_slug_tenant
  ON datasets (tenant_id, slug)
  WHERE scope = 'tenant' AND archived_at IS NULL;
CREATE UNIQUE INDEX datasets_slug_environment
  ON datasets (tenant_id, environment_id, slug)
  WHERE scope = 'environment' AND archived_at IS NULL;

COMMIT;
