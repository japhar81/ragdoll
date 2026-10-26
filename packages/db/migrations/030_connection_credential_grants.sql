-- ADR-0039: Connection Credential Grants (external / sidecar plugins).
--
-- A sidecar plugin runs out-of-process and can't hold a tenant's connection
-- credential ambiently. Instead the dispatcher mints a short-lived, opaque
-- token AFTER `connection:use` has already been enforced, scoped to exactly
-- one (execution, node, connection). The sidecar presents the token back to
-- re-materialise that one connection's credential and nothing else.
--
-- Grant lifecycle, all enforced here:
--   - `token` is the opaque secret the sidecar holds — UNIQUE, the primary
--     redemption lookup.
--   - `redeem_count` / `last_redeemed_at` are issuance audit (how often the
--     sidecar has redeemed), stamped on each successful redemption.
--   - `revoked_at` is set en masse when the execution finishes/cancels (or an
--     admin nuke), so grants die with the run.
--   - `expires_at` is bounded by the run deadline; a leaked token is useless
--     after it, and the housekeeping sweep hard-deletes past-expiry rows.
-- The store never decides validity — the redemption path checks
-- revoked_at / expires_at. This table only persists the facts.
--
-- `execution_id` is the run's TEXT business key (`context.executionId`, what
-- the execution store writes into `executions.execution_id`), NOT the uuid
-- surrogate `executions.id`. So the FK targets `executions(execution_id)` as
-- text — the same convention every other run-scoped table uses (execution_nodes
-- etc. in migration 001). ON DELETE CASCADE so grants are reaped when the
-- execution row is pruned — belt-and-braces alongside the explicit
-- revoke-on-finish path.

CREATE TABLE IF NOT EXISTS connection_credential_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  execution_id text NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  node_id text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment text NOT NULL,
  connection_slug text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  redeem_count integer NOT NULL DEFAULT 0,
  last_redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Bulk revoke-on-finish walks all grants for one execution.
CREATE INDEX IF NOT EXISTS idx_connection_credential_grants_execution
  ON connection_credential_grants(execution_id);

-- Housekeeping sweep scans for past-expiry rows.
CREATE INDEX IF NOT EXISTS idx_connection_credential_grants_expires
  ON connection_credential_grants(expires_at);
