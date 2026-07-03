-- 028_webhook_delivery_failures.sql
--
-- Platform plugins (ADR 0036): dead-letter for webhook deliveries that
-- exhausted their retries. Each row captures the event + target so an operator
-- can inspect and REPLAY it (POST /api/event-subscriptions/failures/:id/replay).
-- `replayed_at` marks a successful replay (kept for audit; a retention sweep
-- can prune old rows).

CREATE TABLE webhook_delivery_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES event_subscriptions(id) ON DELETE SET NULL,
  event_name text NOT NULL,
  url text NOT NULL,
  event jsonb NOT NULL,
  last_error text,
  attempts integer NOT NULL DEFAULT 0,
  failed_at timestamptz NOT NULL DEFAULT now(),
  replayed_at timestamptz
);

CREATE INDEX idx_webhook_delivery_failures_tenant
  ON webhook_delivery_failures (tenant_id, failed_at DESC);
