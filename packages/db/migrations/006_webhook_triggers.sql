-- 006_webhook_triggers.sql
-- Public webhook triggers for pipelines.
--
-- A trigger row binds a tenant/pipeline/environment (optionally an activation
-- label) to a long random token that anyone can POST to in order to start a
-- run. Only the sha256 hash + a 12-char lookup prefix are stored, mirroring
-- the api_keys table; the plaintext `wht_<prefix>_<secret>` is shown ONCE at
-- create time. Revocation is by row delete OR by setting `revoked_at`.

CREATE TABLE IF NOT EXISTS webhook_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  environment text NOT NULL,
  activation_label text,
  name text NOT NULL,
  prefix text NOT NULL UNIQUE,
  hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_triggered_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_webhook_triggers_tenant
  ON webhook_triggers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_webhook_triggers_pipeline
  ON webhook_triggers(pipeline_id);
