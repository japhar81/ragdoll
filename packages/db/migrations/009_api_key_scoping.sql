-- Phase 3 of the dataset/RBAC/retrieval refactor: scope API keys to a
-- specific environment within their tenant and let them expire.
--
-- `environment_id` is a free-text reference to `tenant_environments.name`
-- (rather than a UUID FK) so the legacy "environment is a string on the
-- principal" path keeps working end-to-end. NULL means "all envs in the
-- tenant" — back-compat with every key minted before this migration.
--
-- `expires_at` is optional; NULL means "no expiration" (the legacy
-- semantics). When set, verify() rejects the key once now() is past it,
-- with the same constant-time error shape as a revoked key.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS environment_id text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- Schedule creator capture, kept here so a single migration covers both
-- Phase 2 (scheduler re-check at fire time) and Phase 3. The scheduler
-- already reads this column when wired with an authorizer; null means
-- "legacy schedule, do not re-check" which is the back-compat path the
-- scheduler already handles.

ALTER TABLE schedules
  ADD COLUMN IF NOT EXISTS created_by uuid;

CREATE INDEX IF NOT EXISTS idx_api_keys_environment ON api_keys(environment_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_expires ON api_keys(expires_at);
