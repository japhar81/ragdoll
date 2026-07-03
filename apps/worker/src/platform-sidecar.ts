/**
 * Sidecar hook host (ADR 0036): run platform-plugin hooks OUT OF PROCESS in an
 * operator-configured sidecar over HTTP/JSON. Unlike per-tenant webhooks
 * (DB-configured, allow/deny only) this is:
 *   - operator-global (env `RAGDOLL_HOOK_SIDECAR_URL`),
 *   - full pre-contract (continue / mutate / deny / fail — the sidecar can
 *     rewrite input/output, not just veto),
 *   - both phases (pre in the API + worker request paths; post from the
 *     worker observer consumer).
 *
 * Wire contract — the sidecar receives `POST <url>` with the PlatformEvent as
 * the JSON body and `x-ragdoll-phase: pre|post` (HMAC-signed with
 * RAGDOLL_HOOK_SIDECAR_SECRET when set):
 *   - PRE  → respond 200 with `{ decision: "continue" | "deny" | "fail" |
 *            "mutate", reason?, status?, patch? }`. A non-2xx / timeout / bad
 *            body is fail-open (continue) so a down sidecar never wedges the
 *            platform. (Set RAGDOLL_HOOK_SIDECAR_FAIL_CLOSED=1 to invert.)
 *   - POST → fire-and-forget; the response is ignored.
 *
 * A structured connect-rpc/gRPC transport (like the RAG node-plugin sidecar)
 * is a future upgrade; JSON keeps the sidecar trivial to implement in any
 * language.
 */
import { createHmac } from "node:crypto";
import type { StructuredLogger } from "../../../packages/observability/src/index.ts";
import {
  type EventPatch,
  type InterceptorDecision,
  type PlatformEvent,
  type PlatformPlugin
} from "../../../packages/platform-plugins/src/index.ts";

const PRE_TIMEOUT_MS = 3000;
const POST_TIMEOUT_MS = 5000;

export interface SidecarHookOptions {
  url: string;
  secret?: string;
  /** Invert the pre fail policy: a down/erroring sidecar denies. Default open. */
  failClosed?: boolean;
  logger?: StructuredLogger;
}

interface SidecarPreResponse {
  decision?: "continue" | "deny" | "fail" | "mutate";
  reason?: string;
  status?: number;
  patch?: EventPatch;
}

async function post(
  opts: SidecarHookOptions,
  event: PlatformEvent,
  phase: "pre" | "post",
  timeoutMs: number
): Promise<Response> {
  const body = JSON.stringify(event);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-ragdoll-event": event.event,
    "x-ragdoll-phase": phase
  };
  if (opts.secret) {
    headers["x-ragdoll-signature"] =
      "sha256=" + createHmac("sha256", opts.secret).update(body).digest("hex");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(opts.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

/** The sidecar hook as a platform plugin (registered in API + worker). */
export function sidecarHookPlugin(opts: SidecarHookOptions): PlatformPlugin {
  const failOpen: InterceptorDecision = { action: "continue" };
  return {
    name: "ragdoll.hook-sidecar",
    subscriptions: [{ events: ["*"], phases: ["pre", "post"] }],
    meta: { failurePolicy: opts.failClosed ? "closed" : "open" },

    async before(event): Promise<InterceptorDecision> {
      try {
        const res = await post(opts, event, "pre", PRE_TIMEOUT_MS);
        if (!res.ok) {
          if (opts.failClosed) {
            return { action: "deny", reason: `hook sidecar returned ${res.status}` };
          }
          return failOpen;
        }
        const json = (await res.json().catch(() => ({}))) as SidecarPreResponse;
        switch (json.decision) {
          case "deny":
            return {
              action: "deny",
              reason: json.reason ?? "denied by hook sidecar",
              ...(json.status ? { status: json.status } : {})
            };
          case "fail":
            return { action: "fail", reason: json.reason ?? "failed by hook sidecar" };
          case "mutate":
            return { action: "mutate", patch: json.patch ?? {} };
          default:
            return failOpen;
        }
      } catch (e) {
        opts.logger?.warn?.("hook_sidecar_pre_unreachable", {
          event: event.event,
          error: e instanceof Error ? e.message : String(e)
        });
        return opts.failClosed
          ? { action: "deny", reason: "hook sidecar unreachable (fail-closed)" }
          : failOpen;
      }
    },

    async on(event): Promise<void> {
      try {
        await post(opts, event, "post", POST_TIMEOUT_MS);
      } catch (e) {
        // Isolated: a post-hook sidecar failure never touches the app.
        opts.logger?.warn?.("hook_sidecar_post_failed", {
          event: event.event,
          error: e instanceof Error ? e.message : String(e)
        });
      }
    }
  };
}

/** Build the sidecar hook plugin from env, or undefined when not configured. */
export function sidecarHookFromEnv(
  logger?: StructuredLogger
): PlatformPlugin | undefined {
  const url = process.env.RAGDOLL_HOOK_SIDECAR_URL;
  if (!url) return undefined;
  return sidecarHookPlugin({
    url,
    secret: process.env.RAGDOLL_HOOK_SIDECAR_SECRET,
    failClosed: process.env.RAGDOLL_HOOK_SIDECAR_FAIL_CLOSED === "1",
    logger
  });
}
