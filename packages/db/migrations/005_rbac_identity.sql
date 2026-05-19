-- 005_rbac_identity.sql
-- Authentication + Casbin-style RBAC.
--
-- `users`/`roles`/`user_roles` were declared in 001 but never used (no repos,
-- no routes). `user_roles` is unusable as-is: its PK spans nullable scope
-- columns, which Postgres forbids (a global, tenant-less grant cannot be
-- stored). This migration adds local-credential columns to `users` and
-- introduces a clean, scope-string RBAC model that maps 1:1 onto Casbin:
--   * rbac_role_permissions  -> Casbin `p` policies (role -> permission)
--   * rbac_grants            -> Casbin `g` policies (user -> role @ scope)
-- The scope string is the Casbin domain: `*` (global), `t/<tenantId>`,
-- `t/<tenantId>/e/<environment>`, or `t/<tenantId>/p/<pipelineId>`. A grant
-- at an ancestor scope covers every descendant (see @ragdoll/authz).

-- Local credentials + lifecycle on the existing users table.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

-- Federated identities: one row per (provider, external subject).
CREATE TABLE IF NOT EXISTS user_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  subject text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities(user_id);

-- Configurable SSO connections (OIDC / SAML). `config` holds non-secret
-- connection metadata; client secrets / SP private keys live in @ragdoll/secrets.
CREATE TABLE IF NOT EXISTS identity_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('oidc', 'saml')),
  display_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Role -> permission catalog (Casbin `p`). Editable in the admin UI; seeded
-- from the built-in defaults so a fresh install is immediately usable.
CREATE TABLE IF NOT EXISTS rbac_role_permissions (
  role text NOT NULL,
  permission text NOT NULL,
  PRIMARY KEY (role, permission)
);

-- User -> role @ scope (Casbin `g`). `scope` is the hierarchical domain.
CREATE TABLE IF NOT EXISTS rbac_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  scope text NOT NULL DEFAULT '*',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role, scope)
);
CREATE INDEX IF NOT EXISTS idx_rbac_grants_user ON rbac_grants(user_id);

-- Single-row instance settings (signup mode flag supports all three variants:
-- admin_only | open_default_role | open_no_access).
CREATE TABLE IF NOT EXISTS auth_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  signup_mode text NOT NULL DEFAULT 'admin_only'
    CHECK (signup_mode IN ('admin_only', 'open_default_role', 'open_no_access')),
  default_role text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO auth_settings (id, signup_mode, default_role)
VALUES (true, 'admin_only', 'viewer')
ON CONFLICT (id) DO NOTHING;
