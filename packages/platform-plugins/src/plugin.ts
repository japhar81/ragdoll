/**
 * The platform-plugin SPI + registry.
 *
 * A platform plugin is a GLOBAL, engine-style plugin (not a draggable pipeline
 * node): it subscribes to lifecycle events and runs arbitrary code on them,
 * in two phases —
 *   - `on(event)`     — POST: observational, async, fire-and-forget. Delivered
 *                       durably (NATS) + isolated; a failure never touches the
 *                       app or other plugins.
 *   - `before(event)` — PRE: synchronous interceptor. Returns an
 *                       {@link InterceptorDecision} — continue, mutate (rewrite
 *                       the operation), veto (deny), or force-fail. Run in
 *                       priority order under a per-plugin timeout.
 *
 * Registration mirrors the identity/authz providers: built-ins + a
 * module-import-at-boot loader (RAGDOLL_PLATFORM_PLUGINS) into a
 * {@link PlatformPluginRegistry}. Operator-trust level (in-process code);
 * per-tenant no-code hooks are webhooks layered on top (see the dispatcher).
 */

import type { PlatformEvent, EventPhase } from "./events.ts";
import { eventMatches } from "./catalog.ts";

/** A partial rewrite a `pre` hook may request. The dispatcher applies ONLY the
 *  fields the event's catalog entry marks mutable; others are ignored. */
export interface EventPatch {
  // execution.start
  input?: unknown;
  config?: unknown;
  context?: unknown;
  environment?: string;
  // execution.finish
  output?: unknown;
  // mutation
  before?: unknown;
  after?: unknown;
}

/** A `pre` hook's verdict. */
export type InterceptorDecision =
  | { action: "continue" }
  | { action: "mutate"; patch: EventPatch }
  | { action: "deny"; reason: string; status?: number }
  | { action: "fail"; reason: string };

/** Convenience: proceed unchanged. */
export const CONTINUE: InterceptorDecision = { action: "continue" };

/** Capability-scoped handle passed to every hook invocation. Deliberately
 *  small; grows as capabilities are granted (emit derived events, read safe
 *  services, …). */
export interface HookContext {
  logger?: {
    info?(msg: string, fields?: Record<string, unknown>): void;
    warn?(msg: string, fields?: Record<string, unknown>): void;
    error?(msg: string, fields?: Record<string, unknown>): void;
  };
  /** Aborts when the per-plugin timeout fires (pre lane). */
  signal?: AbortSignal;
  /** Emit a derived PlatformEvent (guarded against re-entrant loops by the
   *  dispatcher). Optional — present only where the host wires it. */
  emit?(event: PlatformEvent): void;
}

/** What events + phases a plugin wants. */
export interface PlatformPluginSubscription {
  /** Event-name patterns (see {@link eventMatches}): `"*"`, `"secret.*"`,
   *  `"execution.finish"`. */
  events: string[];
  /** Which phases; default both. */
  phases?: EventPhase[];
}

export interface PlatformPluginMeta {
  /** Lower runs earlier in the pre lane. Default 100. */
  priority?: number;
  /** Per-invocation deadline (pre lane). Default set by the host. */
  timeoutMs?: number;
  /** What a hook ERROR/timeout means in the pre lane: `open` = proceed
   *  (enrichment hooks), `closed` = deny (compliance hooks). Default `open`
   *  for post-only plugins; a `before` plugin SHOULD set this explicitly. */
  failurePolicy?: "open" | "closed";
}

export interface PlatformPlugin {
  name: string;
  subscriptions: PlatformPluginSubscription[];
  /** POST observer. */
  on?(event: PlatformEvent, ctx: HookContext): Promise<void> | void;
  /** PRE interceptor. */
  before?(
    event: PlatformEvent,
    ctx: HookContext
  ): Promise<InterceptorDecision> | InterceptorDecision;
  meta?: PlatformPluginMeta;
}

function subscribes(
  plugin: PlatformPlugin,
  event: string,
  phase: EventPhase
): boolean {
  return plugin.subscriptions.some(
    (s) =>
      (s.phases ?? ["pre", "post"]).includes(phase) &&
      s.events.some((p) => eventMatches(p, event))
  );
}

const priority = (p: PlatformPlugin): number => p.meta?.priority ?? 100;

/**
 * Holds the registered platform plugins and resolves, for a given event, the
 * ordered set of interceptors (`before`) or observers (`on`). Later
 * registration of the same `name` REPLACES the earlier one (so a custom module
 * can override a built-in).
 */
export class PlatformPluginRegistry {
  private byName = new Map<string, PlatformPlugin>();

  register(plugin: PlatformPlugin): void {
    this.byName.set(plugin.name, plugin);
  }

  list(): PlatformPlugin[] {
    return [...this.byName.values()];
  }

  get(name: string): PlatformPlugin | undefined {
    return this.byName.get(name);
  }

  /** Ordered `before` interceptors subscribed to (event, "pre"). */
  interceptorsFor(event: string): PlatformPlugin[] {
    return this.list()
      .filter((p) => typeof p.before === "function" && subscribes(p, event, "pre"))
      .sort((a, b) => priority(a) - priority(b));
  }

  /** `on` observers subscribed to (event, "post"). Priority-ordered too, though
   *  post delivery is concurrent/independent. */
  observersFor(event: string): PlatformPlugin[] {
    return this.list()
      .filter((p) => typeof p.on === "function" && subscribes(p, event, "post"))
      .sort((a, b) => priority(a) - priority(b));
  }
}
