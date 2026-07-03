/**
 * Built-in platform plugin: per-tenant webhook delivery (ADR 0036 Phase 1c).
 *
 * Subscribes to every `post` event and, for each, looks up the active
 * `event_subscriptions` in the event's tenant scope (the tenant's own rows +
 * platform-scoped rows), filters by the subscription's event globs + phases,
 * and POSTs the PlatformEvent to each `url` — HMAC-signed with the row's
 * `secret`, with a short bounded retry. Runs in the worker (where the observer
 * consumer lives). Best-effort: a delivery failure is logged, never rethrown
 * (the dispatcher isolates observer errors anyway). Durable DLQ/replay is a
 * later phase.
 */
import { createHmac, randomUUID } from "node:crypto";
import type { StructuredLogger } from "../../../packages/observability/src/index.ts";
import type { EventSubscriptionRepository } from "../../../packages/db/src/index.ts";
import type { EventSubscriptionRow } from "../../../packages/db/src/index.ts";
import {
  eventMatches,
  type InterceptorDecision,
  type PlatformEvent,
  type PlatformPlugin
} from "../../../packages/platform-plugins/src/index.ts";

const DELIVERY_TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 2;
/** Synchronous gate webhooks get a tighter deadline — they're on the request
 *  path. */
const GATE_TIMEOUT_MS = 3000;

function signature(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function deliver(
  sub: EventSubscriptionRow,
  event: PlatformEvent,
  logger?: StructuredLogger
): Promise<void> {
  const body = JSON.stringify(event);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-ragdoll-event": event.event,
    "x-ragdoll-delivery": randomUUID()
  };
  if (sub.secret) headers["x-ragdoll-signature"] = signature(sub.secret, body);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const res = await fetch(sub.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal
      });
      if (res.ok) return;
      throw new Error(`status ${res.status}`);
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS) {
        logger?.warn?.("webhook_delivery_failed", {
          subscriptionId: sub.id,
          url: sub.url,
          event: event.event,
          error: e instanceof Error ? e.message : String(e)
        });
        return;
      }
      await sleep(200 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The webhook-delivery plugin, bound to a subscription repository. */
export function webhookDeliveryPlugin(
  repo: EventSubscriptionRepository,
  logger?: StructuredLogger
): PlatformPlugin {
  return {
    name: "ragdoll.webhook-delivery",
    subscriptions: [{ events: ["*"], phases: ["post"] }],
    on: async (event) => {
      const subs = await repo.listActiveForTenant(event.tenantId);
      const matching = subs.filter(
        (s) =>
          s.phases.includes(event.phase) &&
          s.events.some((pattern) => eventMatches(pattern, event.event))
      );
      if (matching.length === 0) return;
      await Promise.all(matching.map((s) => deliver(s, event, logger)));
    }
  };
}

/**
 * Synchronously call one gate webhook and interpret its verdict. Contract:
 * respond 2xx with JSON `{ "allow": false, "reason": "..." }` to VETO;
 * 2xx with `allow` true/absent → allow. A non-2xx / timeout / bad body is
 * treated as ALLOW (fail-open) — a per-tenant webhook being down must not
 * wedge the tenant's operations. Deadline-bounded (it's on the request path).
 */
async function callGate(
  sub: EventSubscriptionRow,
  event: PlatformEvent,
  logger?: StructuredLogger
): Promise<{ deny: true; reason: string } | { deny: false }> {
  const body = JSON.stringify(event);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-ragdoll-event": event.event,
    "x-ragdoll-phase": "pre"
  };
  if (sub.secret) headers["x-ragdoll-signature"] = signature(sub.secret, body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATE_TIMEOUT_MS);
  try {
    const res = await fetch(sub.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal
    });
    if (!res.ok) return { deny: false }; // fail-open
    const json = (await res.json().catch(() => ({}))) as {
      allow?: boolean;
      reason?: string;
    };
    if (json.allow === false) {
      return { deny: true, reason: json.reason ?? `vetoed by webhook ${sub.id}` };
    }
    return { deny: false };
  } catch (e) {
    // Unreachable / timeout → fail-open (logged).
    logger?.warn?.("gate_webhook_unreachable", {
      subscriptionId: sub.id,
      url: sub.url,
      event: event.event,
      error: e instanceof Error ? e.message : String(e)
    });
    return { deny: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Built-in PRE interceptor: per-tenant SYNCHRONOUS gate webhooks. A
 * subscription with `pre` in its phases is a gate — it can VETO an operation.
 * Runs matching gates concurrently; the FIRST veto denies (→ 4xx on the API
 * path, terminal on the execution path). Fail-open by construction (see
 * {@link callGate}).
 */
export function gateWebhookPlugin(
  repo: EventSubscriptionRepository,
  logger?: StructuredLogger
): PlatformPlugin {
  return {
    name: "ragdoll.webhook-gate",
    subscriptions: [{ events: ["*"], phases: ["pre"] }],
    meta: { failurePolicy: "open" },
    before: async (event): Promise<InterceptorDecision> => {
      const subs = await repo.listActiveForTenant(event.tenantId);
      const gates = subs.filter(
        (s) =>
          s.phases.includes("pre") &&
          s.events.some((pattern) => eventMatches(pattern, event.event))
      );
      if (gates.length === 0) return { action: "continue" };
      const verdicts = await Promise.all(
        gates.map((s) => callGate(s, event, logger))
      );
      const denied = verdicts.find((v) => v.deny) as
        | { deny: true; reason: string }
        | undefined;
      return denied
        ? { action: "deny", reason: denied.reason, status: 403 }
        : { action: "continue" };
    }
  };
}
