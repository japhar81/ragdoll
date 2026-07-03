/**
 * The dispatch engine — pure, transport-agnostic. Two lanes:
 *
 *   - `intercept(event)` — the PRE lane. Runs the matching `before()` hooks in
 *     priority order, each under a per-plugin timeout. A `mutate` composes into
 *     an accumulated patch AND updates the working event so the next hook sees
 *     the change; a `deny`/`fail` short-circuits. A hook error/timeout is
 *     resolved by its `failurePolicy` (open → continue, closed → deny). Returns
 *     the final decision + the merged patch for the CALLER to apply to the real
 *     operation (the dispatcher never mutates anything but the event snapshot).
 *
 *   - `deliver(event)` — the POST lane. Fans out to the matching `on()`
 *     observers concurrently, each isolated (its failure is logged, never
 *     rethrown, never affects the app or the other observers).
 *
 * The durable transport (publish to NATS, consume, call `deliver`) wraps this
 * from the host — see the worker wiring. Keeping the engine pure makes the
 * ordering / timeout / veto / mutate semantics unit-testable with no I/O.
 */

import type { PlatformEvent } from "./events.ts";
import { catalogEntry } from "./catalog.ts";
import {
  type EventPatch,
  type HookContext,
  type InterceptorDecision,
  type PlatformPlugin,
  type PlatformPluginRegistry
} from "./plugin.ts";

export interface DispatcherOptions {
  /** Per-plugin pre-lane deadline when a plugin doesn't set its own. */
  defaultTimeoutMs?: number;
  logger?: HookContext["logger"];
}

/** Outcome of the pre lane. `event` is the (possibly mutated) snapshot;
 *  `patch` is the merged set of catalog-allowed changes for the caller to
 *  apply to the actual operation. */
export interface InterceptResult {
  decision:
    | { action: "continue" }
    | { action: "deny"; reason: string; status?: number }
    | { action: "fail"; reason: string };
  event: PlatformEvent;
  patch: EventPatch;
}

const ENVELOPE_PATCH_FIELDS = new Set([
  "input",
  "output",
  "before",
  "after",
  "environment"
]);

/** Keep only the patch fields the catalog marks mutable for this event. */
function filterPatch(patch: EventPatch, allowed: string[]): EventPatch {
  const out: EventPatch = {};
  for (const key of allowed) {
    if (key in patch) {
      (out as Record<string, unknown>)[key] = (patch as Record<string, unknown>)[key];
    }
  }
  return out;
}

/** Apply the envelope-visible fields of a patch onto a cloned event so the
 *  next interceptor observes the change. Non-envelope fields (config/context)
 *  ride along in the merged patch for the caller only. */
function applyEnvelopePatch(event: PlatformEvent, patch: EventPatch): PlatformEvent {
  const next = { ...event } as Record<string, unknown>;
  for (const key of Object.keys(patch)) {
    if (ENVELOPE_PATCH_FIELDS.has(key)) {
      next[key] = (patch as Record<string, unknown>)[key];
    }
  }
  return next as unknown as PlatformEvent;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Race a hook against its deadline; abort the hook's signal on timeout. */
function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  controller: AbortController
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`hook timed out after ${ms}ms`));
    }, ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Fire-and-forget sink for `post` events. The host wires this to the durable
 * NATS stream (production) or straight to a dispatcher (single-process / tests
 * via {@link inProcessEmitter}). Emitters MUST NOT throw — a broken event
 * pipeline can never break the operation that produced the event.
 */
export type PlatformEmitter = (event: PlatformEvent) => void;

/** An emitter that delivers straight to a local dispatcher (no transport) —
 *  for the single-process worker / offline tests. */
export function inProcessEmitter(
  dispatcher: PlatformEventDispatcher,
  onError?: (e: unknown) => void
): PlatformEmitter {
  return (event) => {
    void dispatcher.deliver(event).catch((e) => onError?.(e));
  };
}

export class PlatformEventDispatcher {
  private readonly registry: PlatformPluginRegistry;
  private readonly opts: DispatcherOptions;

  constructor(registry: PlatformPluginRegistry, opts: DispatcherOptions = {}) {
    this.registry = registry;
    this.opts = opts;
  }

  /** PRE lane. */
  async intercept(event: PlatformEvent): Promise<InterceptResult> {
    const entry = catalogEntry(event.event);
    let working = event;
    const merged: EventPatch = {};
    for (const plugin of this.registry.interceptorsFor(event.event)) {
      const decision = await this.runBefore(plugin, working);
      if (decision.action === "deny") {
        return {
          decision: {
            action: "deny",
            reason: decision.reason,
            ...(decision.status !== undefined ? { status: decision.status } : {})
          },
          event: working,
          patch: merged
        };
      }
      if (decision.action === "fail") {
        return {
          decision: { action: "fail", reason: decision.reason },
          event: working,
          patch: merged
        };
      }
      if (decision.action === "mutate") {
        const allowed = filterPatch(decision.patch, entry.mutablePatch);
        Object.assign(merged, allowed);
        working = applyEnvelopePatch(working, allowed);
      }
    }
    return { decision: { action: "continue" }, event: working, patch: merged };
  }

  /** POST lane — isolated, concurrent, never throws. */
  async deliver(event: PlatformEvent): Promise<void> {
    await Promise.all(
      this.registry.observersFor(event.event).map((p) => this.runOn(p, event))
    );
  }

  private async runBefore(
    plugin: PlatformPlugin,
    event: PlatformEvent
  ): Promise<InterceptorDecision> {
    const timeoutMs = plugin.meta?.timeoutMs ?? this.opts.defaultTimeoutMs ?? 1000;
    const controller = new AbortController();
    const ctx: HookContext = { logger: this.opts.logger, signal: controller.signal };
    try {
      return await withTimeout(
        Promise.resolve(plugin.before!(event, ctx)),
        timeoutMs,
        controller
      );
    } catch (e) {
      const policy = plugin.meta?.failurePolicy ?? "open";
      this.opts.logger?.error?.("platform_plugin_before_error", {
        plugin: plugin.name,
        event: event.event,
        policy,
        error: errMsg(e)
      });
      return policy === "closed"
        ? { action: "deny", reason: `interceptor "${plugin.name}" failed (fail-closed): ${errMsg(e)}` }
        : { action: "continue" };
    }
  }

  private async runOn(
    plugin: PlatformPlugin,
    event: PlatformEvent
  ): Promise<void> {
    const ctx: HookContext = { logger: this.opts.logger };
    try {
      await plugin.on!(event, ctx);
    } catch (e) {
      // Isolated: an observer failure never touches the app or its peers.
      this.opts.logger?.error?.("platform_plugin_on_error", {
        plugin: plugin.name,
        event: event.event,
        error: errMsg(e)
      });
    }
  }
}
