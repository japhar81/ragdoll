/**
 * Live-events WebSocket endpoint (`/api/events`).
 *
 * One connection per browser tab (or other client). The wire protocol is
 * defined in `@ragdoll/events` so the web client and this handler share a
 * single source of truth. Concerns split:
 *
 *  - **Auth-after-open**: a freshly opened socket has no headers we trust, so
 *    the client's first frame MUST be `{type:"auth", token|apiKey}`. The
 *    server runs the same `AuthResolver` the REST router uses, then attaches
 *    an Authorizer closure so the rest of this module can call
 *    `principal.authorize(perm, resource)` without re-implementing RBAC.
 *
 *  - **Tenant scope filtering**: every ChangeEvent crosses the connection's
 *    `canSee()` filter before it is sent. Platform-scope users see
 *    everything; tenant-scoped users see only events for tenants they hold
 *    grants in; global (`tenantId === null`) events go to platform-scope
 *    users only.
 *
 *  - **Builder rooms**: the collaborative-editor channel is built on top of
 *    the same socket. Joining a room enforces `pipeline:update` at the
 *    pipeline scope so a viewer cannot see another tenant's draft. Presence
 *    and edits broadcast only to room members.
 */
import { randomUUID } from "node:crypto";
import websocketPlugin, { type WebSocket } from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  AuthResolver,
  InvalidCredentialsError,
  TokenExpiredError,
  TokenInvalidError,
  UnauthorizedError,
  enforce,
  type Permission,
  type Principal
} from "../../../packages/auth/src/index.ts";
import { AuthorizationError, type Authorizer } from "../../../packages/authz/src/index.ts";
import type { StructuredLogger } from "../../../packages/observability/src/index.ts";
import type {
  ChangeBus,
  ChangeEvent,
  BuilderEdit,
  BuilderPresence,
  WsClientMessage,
  WsServerMessage
} from "../../../packages/events/src/index.ts";

/** Authentication must arrive within this window or the server closes the
 *  socket. Long enough to absorb a slow page-load + token-fetch, short enough
 *  that an unauthenticated peer cannot squat on a connection slot. */
const AUTH_TIMEOUT_MS = 10_000;

/** A room with no members for this long is reaped. Members refresh
 *  via `presence` heartbeats; the web client sends one on focus changes
 *  and at most every ~5s of editor activity. */
const ROOM_IDLE_MS = 60_000;

/** Per-connection state held by the WebSocket server. */
interface ConnState {
  id: string;
  socket: WebSocket;
  principal?: Principal;
  /** Computed once on auth. True for any grant at global scope. */
  seesGlobal: boolean;
  /** Set of tenant ids the principal holds any grant covering. Refreshed
   *  every WS_GRANT_REFRESH_MS (default 60s) by re-resolving against the
   *  authorizer; sockets whose principal lost ALL grants are closed by
   *  the refresh loop in mountWebsocket. The REST path re-resolves on
   *  every request and stays the source of truth — this is a per-socket
   *  best-effort enforcement so a stale tab doesn't keep streaming
   *  builder/execution events forever after a grant change. */
  tenants: Set<string>;
  /** When `tenants` was last refreshed from the authorizer. */
  tenantsRefreshedAtMs: number;
  /** Builder rooms this connection has joined. */
  rooms: Set<string>;
  /** Latest presence snapshot. */
  presence: BuilderPresence;
}

export interface MountWebsocketOptions {
  bus: ChangeBus;
  auth: AuthResolver;
  authorizer?: Authorizer;
  logger: StructuredLogger;
}

function initials(label: string): string {
  const parts = label
    .replace(/@.*/, "") // strip email domain
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function send(conn: ConnState, msg: WsServerMessage): void {
  if (conn.socket.readyState !== conn.socket.OPEN) return;
  try {
    conn.socket.send(JSON.stringify(msg));
  } catch {
    /* socket closed mid-flight; cleanup runs via the close handler */
  }
}

function parseMessage(raw: unknown): WsClientMessage | undefined {
  let text: string;
  if (typeof raw === "string") text = raw;
  else if (Buffer.isBuffer(raw)) text = raw.toString("utf8");
  else if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString("utf8");
  else return undefined;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
      return parsed as WsClientMessage;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

/** Extract tenant id from a scope string like `t/<uuid>/...`. */
function tenantFromScope(scope: string): string | undefined {
  const m = /^t\/([^/]+)/.exec(scope);
  return m ? m[1] : undefined;
}

function canSee(conn: ConnState, event: ChangeEvent): boolean {
  // First gate: tenant scope. Platform-scope subscribers see everything;
  // tenant-scoped subscribers only see events for tenants they hold any
  // grant in; global (`tenantId === null`) events are platform-only.
  if (!conn.seesGlobal) {
    if (event.tenantId === null) return false;
    if (!conn.tenants.has(event.tenantId)) return false;
  }
  // Second gate: per-event permission filter. Untagged events pass; tagged
  // ones require the subscriber to hold the permission at the event's
  // tenant scope. Without `principal.authorize` (older session paths where
  // the closure was never attached) we fall closed on tagged events —
  // tagged events are inherently sensitive.
  if (event.requiredPermission && conn.principal) {
    const authorize = conn.principal.authorize;
    if (!authorize) return false;
    return authorize(
      event.requiredPermission as Permission,
      event.tenantId ? { tenantId: event.tenantId } : {}
    );
  }
  return true;
}

export async function mountWebsocket(
  app: FastifyInstance,
  options: MountWebsocketOptions
): Promise<void> {
  const { bus, auth, authorizer, logger } = options;

  // Awaiting register is required: routes added with `{websocket:true}` are
  // only treated as upgrades if the plugin has already decorated the instance
  // by the time the route is added. Otherwise Fastify falls back to the
  // ordinary HTTP handler and the WS client gets a 500 on upgrade.
  await app.register(websocketPlugin);

  /** All live connections (authenticated or not). */
  const connections = new Map<string, ConnState>();
  /** pipelineId -> connection ids subscribed to that Builder room. */
  const rooms = new Map<string, Set<string>>();

  function rosterFor(pipelineId: string): BuilderPresence[] {
    const ids = rooms.get(pipelineId);
    if (!ids) return [];
    const members: BuilderPresence[] = [];
    for (const id of ids) {
      const c = connections.get(id);
      if (c) members.push(c.presence);
    }
    return members;
  }

  function broadcastRoster(pipelineId: string): void {
    const members = rosterFor(pipelineId);
    const ids = rooms.get(pipelineId);
    if (!ids) return;
    for (const id of ids) {
      const c = connections.get(id);
      if (c) send(c, { type: "builder:roster", pipelineId, members });
    }
  }

  function leaveRoom(conn: ConnState, pipelineId: string): void {
    const ids = rooms.get(pipelineId);
    if (ids && ids.delete(conn.id)) {
      conn.rooms.delete(pipelineId);
      if (ids.size === 0) rooms.delete(pipelineId);
      else broadcastRoster(pipelineId);
    }
  }

  // One subscription, many connections — far cheaper than N subscriptions
  // for N clients, and keeps the bus implementation simple.
  const unsubscribeBus = bus.subscribe((event) => {
    for (const conn of connections.values()) {
      if (!conn.principal) continue;
      if (!canSee(conn, event)) continue;
      send(conn, { type: "event", event });
    }
  });

  app.addHook("onClose", async () => {
    unsubscribeBus();
    for (const conn of connections.values()) {
      try {
        conn.socket.close();
      } catch {
        /* best-effort */
      }
    }
    connections.clear();
    rooms.clear();
  });

  app.get(
    "/api/events",
    { websocket: true },
    (socket: WebSocket, _req: FastifyRequest) => {
      const id = randomUUID();
      const conn: ConnState = {
        id,
        socket,
        seesGlobal: false,
        tenants: new Set(),
        tenantsRefreshedAtMs: Date.now(),
        rooms: new Set(),
        presence: {
          connectionId: id,
          principalId: "",
          label: "",
          initials: "?",
          lastSeenAt: new Date().toISOString()
        }
      };
      connections.set(id, conn);

      const authTimer = setTimeout(() => {
        if (!conn.principal) {
          send(conn, {
            type: "error",
            code: "auth_timeout",
            message: "no auth frame received"
          });
          try {
            socket.close(1008, "auth_timeout");
          } catch {
            /* best-effort */
          }
        }
      }, AUTH_TIMEOUT_MS);

      socket.on("message", async (raw: Buffer | string | ArrayBuffer) => {
        const msg = parseMessage(raw);
        if (!msg) {
          send(conn, {
            type: "error",
            code: "bad_message",
            message: "unparseable frame"
          });
          return;
        }

        if (msg.type === "auth") {
          if (conn.principal) return; // re-auth ignored
          await handleAuth(conn, msg, { auth, authorizer, logger });
          clearTimeout(authTimer);
          return;
        }

        if (!conn.principal) {
          send(conn, {
            type: "error",
            code: "unauthenticated",
            message: "send an auth frame first"
          });
          return;
        }

        switch (msg.type) {
          case "ping":
            send(conn, { type: "pong" });
            return;
          case "builder:join":
            try {
              enforce(conn.principal, "pipeline:update" as Permission, {
                pipelineId: msg.pipelineId
              });
            } catch (e) {
              if (e instanceof AuthorizationError) {
                send(conn, {
                  type: "error",
                  code: "forbidden",
                  message: `not allowed to edit pipeline ${msg.pipelineId}`
                });
                return;
              }
              throw e;
            }
            conn.presence.focusNodeId = msg.focusNodeId ?? null;
            conn.presence.lastSeenAt = new Date().toISOString();
            conn.rooms.add(msg.pipelineId);
            let set = rooms.get(msg.pipelineId);
            if (!set) {
              set = new Set();
              rooms.set(msg.pipelineId, set);
            }
            set.add(conn.id);
            broadcastRoster(msg.pipelineId);
            return;
          case "builder:leave":
            leaveRoom(conn, msg.pipelineId);
            return;
          case "builder:presence":
            if (!conn.rooms.has(msg.pipelineId)) return;
            conn.presence.focusNodeId = msg.focusNodeId ?? null;
            conn.presence.lastSeenAt = new Date().toISOString();
            broadcastRoster(msg.pipelineId);
            return;
          case "builder:edit": {
            if (!conn.rooms.has(msg.pipelineId)) {
              send(conn, {
                type: "error",
                code: "not_in_room",
                message: "join the room before broadcasting edits"
              });
              return;
            }
            const edit: BuilderEdit = {
              pipelineId: msg.pipelineId,
              at: new Date().toISOString(),
              fromConnectionId: conn.id,
              fromLabel: conn.presence.label,
              spec: msg.spec,
              nodeStamps: msg.nodeStamps
            };
            const ids = rooms.get(msg.pipelineId);
            if (!ids) return;
            for (const otherId of ids) {
              if (otherId === conn.id) continue;
              const other = connections.get(otherId);
              if (other) {
                send(other, {
                  type: "builder:edit",
                  pipelineId: msg.pipelineId,
                  edit
                });
              }
            }
            // Bump our own lastSeen so the roster reflects activity.
            conn.presence.lastSeenAt = edit.at;
            broadcastRoster(msg.pipelineId);
            return;
          }
        }
      });

      socket.on("close", () => {
        clearTimeout(authTimer);
        for (const pipelineId of [...conn.rooms]) leaveRoom(conn, pipelineId);
        connections.delete(id);
      });

      socket.on("error", (e: Error) => {
        logger.warn?.("ws_socket_error", { id, error: e.message });
      });
    }
  );

  // Periodically reap idle members (a tab that closed before its 'leave'
  // landed). One Map sweep per minute is cheap and keeps the roster honest.
  const reaper = setInterval(() => {
    const cutoff = Date.now() - ROOM_IDLE_MS;
    for (const [pipelineId, ids] of [...rooms]) {
      let dirty = false;
      for (const id of [...ids]) {
        const c = connections.get(id);
        if (!c) {
          ids.delete(id);
          dirty = true;
          continue;
        }
        const last = Date.parse(c.presence.lastSeenAt);
        if (Number.isFinite(last) && last < cutoff && !c.rooms.has(pipelineId)) {
          ids.delete(id);
          dirty = true;
        }
      }
      if (ids.size === 0) rooms.delete(pipelineId);
      else if (dirty) broadcastRoster(pipelineId);
    }
  }, 30_000);
  // The Node timer keeps the event loop alive otherwise; the API process is
  // the one that wants to control its own lifetime.
  reaper.unref?.();

  // ADR-0015 follow-through: live grant re-resolve. Every WS_GRANT_REFRESH_MS
  // (default 60s) walk authenticated sockets, re-resolve their reach against
  // the authorizer, and close any whose grants collapsed to zero scope.
  // This is intentionally coarse — the REST path stays the source of truth,
  // and a one-minute lag on a stale tab is fine. Disable with
  // WS_GRANT_REFRESH_MS=0 if the periodic load isn't worth it.
  const refreshMs = Number(process.env.WS_GRANT_REFRESH_MS);
  const refreshInterval =
    Number.isFinite(refreshMs) && refreshMs >= 0 ? refreshMs : 60_000;
  let grantRefresher: ReturnType<typeof setInterval> | undefined;
  if (refreshInterval > 0 && authorizer) {
    grantRefresher = setInterval(async () => {
      for (const conn of connections.values()) {
        if (!conn.principal) continue;
        try {
          const grants = await authorizer.resolveGrants({
            id: conn.principal.id,
            type: conn.principal.type,
            tenantId: conn.principal.tenantId,
            roles: conn.principal.roles
          });
          let nextSeesGlobal = false;
          const nextTenants = new Set<string>();
          for (const g of grants) {
            if (g.scope === "*") nextSeesGlobal = true;
            else {
              const t = tenantFromScope(g.scope);
              if (t) nextTenants.add(t);
            }
          }
          // Explicit-roles principals (api_key) keep their original reach
          // since the grant resolver isn't authoritative for them.
          if (conn.principal.roles && conn.principal.roles.length > 0) continue;
          if (!nextSeesGlobal && nextTenants.size === 0) {
            // No reach left — close the socket. Client can reconnect with
            // fresh credentials if its grants are restored.
            try {
              conn.socket.close(4403, "grants_revoked");
            } catch {
              /* best-effort */
            }
            continue;
          }
          conn.seesGlobal = nextSeesGlobal;
          conn.tenants = nextTenants;
          conn.tenantsRefreshedAtMs = Date.now();
        } catch (e) {
          logger.warn?.("ws_grant_refresh_failed", {
            connectionId: conn.id,
            error: e instanceof Error ? e.message : String(e)
          });
        }
      }
    }, refreshInterval);
    grantRefresher.unref?.();
  }
}

/**
 * Verify the auth frame, compute scope reach, and either send `ready` or
 * close with an error. Extracted so the message handler stays readable.
 */
async function handleAuth(
  conn: ConnState,
  msg: Extract<WsClientMessage, { type: "auth" }>,
  ctx: {
    auth: AuthResolver;
    authorizer?: Authorizer;
    logger: StructuredLogger;
  }
): Promise<void> {
  const headers: Record<string, string> = {};
  if (msg.token) headers.authorization = `Bearer ${msg.token}`;
  else if (msg.apiKey) headers.authorization = `ApiKey ${msg.apiKey}`;

  let principal: Principal;
  try {
    principal = await ctx.auth.resolve({ headers });
  } catch (e) {
    if (
      e instanceof UnauthorizedError ||
      e instanceof InvalidCredentialsError ||
      e instanceof TokenInvalidError ||
      e instanceof TokenExpiredError
    ) {
      send(conn, {
        type: "error",
        code: "unauthorized",
        message: e.message
      });
      try {
        conn.socket.close(1008, "unauthorized");
      } catch {
        /* best-effort */
      }
      return;
    }
    ctx.logger.error?.("ws_auth_unexpected_error", {
      error: e instanceof Error ? e.message : String(e)
    });
    try {
      conn.socket.close(1011, "auth_failed");
    } catch {
      /* best-effort */
    }
    return;
  }

  // Compute the connection's scope reach so we can filter events without an
  // RBAC lookup per event. Two paths feed it:
  //   - explicit-roles principals (api_key / service / dev) carry their
  //     scope on `principal.tenantId`;
  //   - session-user principals have no roles in the token, so we resolve
  //     their grants from the policy store via the authorizer.
  const reach = { seesGlobal: false, tenants: new Set<string>() };
  if (principal.roles && principal.roles.length > 0) {
    if (principal.tenantId) reach.tenants.add(principal.tenantId);
    else reach.seesGlobal = true;
  } else if (ctx.authorizer) {
    try {
      const grants = await ctx.authorizer.resolveGrants({
        id: principal.id,
        type: principal.type,
        tenantId: principal.tenantId,
        roles: principal.roles
      });
      for (const g of grants) {
        if (g.scope === "*") reach.seesGlobal = true;
        else {
          const t = tenantFromScope(g.scope);
          if (t) reach.tenants.add(t);
        }
      }
    } catch (e) {
      ctx.logger.warn?.("ws_resolve_grants_failed", {
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  // Attach the authorizer closure so `enforce()` calls inside the message
  // handler hit the live RBAC store (matching the REST path).
  if (ctx.authorizer) {
    try {
      principal.authorize = await ctx.authorizer.authorizeClosure(
        {
          id: principal.id,
          type: principal.type,
          tenantId: principal.tenantId,
          environment: principal.environment,
          roles: principal.roles
        },
        { defaultTenantId: principal.tenantId }
      );
    } catch (e) {
      ctx.logger.warn?.("ws_authorize_closure_failed", {
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  conn.principal = principal;
  conn.seesGlobal = reach.seesGlobal;
  conn.tenants = reach.tenants;
  conn.tenantsRefreshedAtMs = Date.now();
  conn.presence.principalId = principal.id;
  // Best-effort display label: session principals carry no name field; the
  // client may overwrite via presence frames with their resolved user record.
  const label = principal.id;
  conn.presence.label = label;
  conn.presence.initials = initials(label);

  send(conn, {
    type: "ready",
    connectionId: conn.id,
    principal: {
      id: principal.id,
      type: principal.type,
      tenantId: principal.tenantId ?? null
    }
  });
}
