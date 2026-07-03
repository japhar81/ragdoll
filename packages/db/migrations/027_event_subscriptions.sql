-- 027_event_subscriptions.sql
--
-- Platform plugins, Phase 1c (ADR 0036): per-tenant, no-code webhook
-- subscriptions to platform events. A row says "POST every matching `post`
-- PlatformEvent to `url`, signed with `secret`". The worker's built-in
-- webhook-delivery plugin reads active rows and delivers from the durable
-- `ragdoll.events` stream.
--
--   tenant_id NULL = a platform-scoped subscription (sees every event,
--   including platform-level ones) — admin-only. A non-null tenant_id only
--   ever receives that tenant's events (per-tenant isolation enforced at
--   delivery time).
--   events  = event-name glob patterns ("secret.*", "execution.failure", "*").
--   phases  = which phases to deliver; only "post" is delivered today (a
--             synchronous "gate"/pre webhook is a later option), but the
--             column is future-proofed.

CREATE TABLE event_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  events text[] NOT NULL DEFAULT '{}',
  phases text[] NOT NULL DEFAULT '{post}',
  url text NOT NULL,
  secret text,
  active boolean NOT NULL DEFAULT true,
  description text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Delivery reads active rows for (this tenant OR platform-scoped); index both.
CREATE INDEX idx_event_subscriptions_tenant_active
  ON event_subscriptions (tenant_id, active);
