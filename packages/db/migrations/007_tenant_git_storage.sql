-- 007: per-tenant Git-backed storage.
--
-- Adds `tenants.storage_mode` ('db' | 'git') and a `tenant_git_configs`
-- side table that holds everything the sync engine needs: remote URL,
-- branch, path prefix inside the repo (so multiple tenants can share a
-- repo), auth method + the secret ref carrying the credentials, and
-- last-synced markers so the polling loop can do incremental diffs.
--
-- The wrapped per-tenant DEK (data encryption key) lives here too so the
-- secrets bundle in the repo can be decrypted on read; the wrap key
-- (KEK) stays in the process env (`SECRET_ENCRYPTION_KEY`) so a stolen
-- Postgres dump alone can't recover plaintext.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS storage_mode text NOT NULL DEFAULT 'db'
    CHECK (storage_mode IN ('db', 'git'));

CREATE TABLE IF NOT EXISTS tenant_git_configs (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  remote_url text NOT NULL,
  branch text NOT NULL DEFAULT 'main',
  path_prefix text NOT NULL DEFAULT '',
  auth_method text NOT NULL CHECK (auth_method IN ('https', 'ssh')),
  -- Reference to a SecretRecord holding either an HTTPS PAT (https) or
  -- an SSH private key (ssh). Resolved at sync time via SecretProvider.
  auth_secret_id uuid NOT NULL REFERENCES secret_refs(id) ON DELETE RESTRICT,
  -- AES-256-GCM data encryption key, wrapped by the instance KEK
  -- (`SECRET_ENCRYPTION_KEY`). Base64 of (iv|tag|ciphertext) per the same
  -- format the secret provider uses.
  dek_wrapped text NOT NULL,
  poll_interval_sec integer NOT NULL DEFAULT 60
    CHECK (poll_interval_sec BETWEEN 10 AND 3600),
  last_synced_sha text,
  last_synced_at timestamptz,
  last_sync_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_git_configs_due
  ON tenant_git_configs(last_synced_at);
