CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL,
  name text NOT NULL,
  prefix text NOT NULL UNIQUE,
  hash text NOT NULL,
  roles text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL,
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX idx_api_keys_principal ON api_keys(principal_id);
CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);
CREATE INDEX idx_sessions_principal ON sessions(principal_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
