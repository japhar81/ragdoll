/**
 * Live-events client for the web UI.
 *
 * Owns ONE WebSocket per browser tab, bound to the active session. The
 * connection lifecycle and reconnect-with-backoff live here; per-screen
 * code just consumes `useEvents()` / `useChangeEvents()` / `useBuilderRoom()`.
 *
 * Wire protocol is shared via `@ragdoll/events` (`packages/events`) so the
 * client and the Fastify handler in `apps/api/src/websocket.ts` never drift.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext.tsx";
import { loadToken } from "../lib/auth.ts";
import type {
  BuilderEdit,
  BuilderPresence,
  ChangeEvent,
  WsClientMessage,
  WsServerMessage
} from "../../../../packages/events/src/index.ts";

export type EventsStatus =
  | "offline"
  | "connecting"
  | "connected"
  | "reconnecting";

export interface EventsApi {
  status: EventsStatus;
  connectionId: string | null;
  /** Raw send. App code should prefer the typed helpers. */
  send: (msg: WsClientMessage) => void;
  /** Subscribe to every authorized ChangeEvent. Returns unsubscribe. */
  onEvent: (handler: (e: ChangeEvent) => void) => () => void;
  /** Subscribe to a Builder room's roster updates. */
  onRoster: (
    pipelineId: string,
    handler: (members: BuilderPresence[]) => void
  ) => () => void;
  /** Subscribe to inbound edits broadcast inside a Builder room. */
  onEdit: (
    pipelineId: string,
    handler: (edit: BuilderEdit) => void
  ) => () => void;
}

const EventsCtx = createContext<EventsApi | undefined>(undefined);

export function useEvents(): EventsApi {
  const ctx = useContext(EventsCtx);
  if (!ctx) throw new Error("useEvents must be used within <EventsProvider>");
  return ctx;
}

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/events`;
}

/**
 * Per-action React Query invalidation map. Keys are the canonical audit
 * action strings published by the API; values are query-key prefixes to
 * invalidate. Prefix-match is intentional — e.g. invalidating ["versions"]
 * also refreshes ["versions", pipelineId] without listing every pipeline.
 *
 * Anything not in this table is still delivered to event subscribers; only
 * the global auto-invalidation skips it.
 */
const INVALIDATIONS: Record<string, string[][]> = {
  // Tenants & environments
  "tenant.create": [["tenants"]],
  "tenant.update": [["tenants"], ["tenant-storage"]],
  "tenant.delete": [
    ["tenants"],
    ["tenant-pipelines"],
    ["tenant-pipelines-all"],
    ["schedules"]
  ],
  "tenant_git.upsert": [["tenant-storage"]],
  "tenant_git.delete": [["tenant-storage"]],
  "tenant_git.sync_requested": [["tenant-storage"]],
  "environment.create": [["environments"]],
  "environment.update": [["environments"]],
  "environment.delete": [["environments"]],
  // Pipelines / versions / folders / deployments
  "pipeline.create": [["pipelines"], ["folders"]],
  "pipeline.update": [["pipelines"]],
  "pipeline.delete": [
    ["pipelines"],
    ["folders"],
    ["tenant-pipelines"],
    ["tenant-pipelines-all"]
  ],
  "pipeline.set_folder": [["pipelines"], ["folders"]],
  "pipeline.deploy": [["pipelines"], ["versions"]],
  "pipeline.ingest": [["executions"]],
  "pipeline.run": [["executions"]],
  "pipeline_version.save": [["versions"], ["pipelines"]],
  "pipeline_version.save_draft": [["versions"]],
  "pipeline_version.publish": [["versions"], ["pipelines"]],
  "pipeline_version.archive": [["versions"]],
  "pipeline_version.rollback": [["versions"], ["pipelines"]],
  "pipeline_folder.create": [["folders"]],
  "pipeline_folder.update": [["folders"]],
  "pipeline_folder.delete": [["folders"]],
  // Activations / schedules
  "pipeline_activation.create": [
    ["tenant-pipelines"],
    ["tenant-pipelines-all"]
  ],
  "pipeline_activation.update": [
    ["tenant-pipelines"],
    ["tenant-pipelines-all"]
  ],
  "pipeline_activation.delete": [
    ["tenant-pipelines"],
    ["tenant-pipelines-all"]
  ],
  "tenant_pipeline.associate": [
    ["tenant-pipelines"],
    ["tenant-pipelines-all"]
  ],
  "tenant_pipeline.update": [["tenant-pipelines"], ["tenant-pipelines-all"]],
  "schedule.create": [["schedules"]],
  "schedule.update": [["schedules"]],
  "schedule.toggle": [["schedules"]],
  "schedule.delete": [["schedules"]],
  // Config / secrets
  "config_definition.upsert": [["config-definitions"]],
  "config_definition.delete": [["config-definitions"]],
  "config_value.upsert": [["config-values"], ["resolved-config"]],
  "config_value.delete": [["config-values"], ["resolved-config"]],
  "secret.create": [["secrets"]],
  "secret.rotate": [["secrets"]],
  "secret.delete": [["secrets"]],
  // Auth / RBAC
  "user.create": [["users"]],
  "user.update": [["users"]],
  "user.delete": [["users"]],
  "user.grant": [["users"], ["grants"]],
  "user.revoke": [["users"], ["grants"]],
  "user.password_change": [],
  "role.create": [["roles"]],
  "role.set_permissions": [["roles"]],
  "role.delete": [["roles"]],
  "idp.create": [["identity-providers"]],
  "idp.update": [["identity-providers"]],
  "idp.delete": [["identity-providers"]],
  "auth.settings.update": [["auth-settings"]],
  "apikey.create": [["api-keys"]],
  "apikey.revoke": [["api-keys"]],
  // Webhook triggers
  "webhook_trigger.create": [["pipelines"]],
  "webhook_trigger.delete": [["pipelines"]],
  // Execution lifecycle (from the worker)
  "execution.started": [["executions"], ["trace"]],
  "execution.updated": [["executions"], ["trace"]],
  "execution.node.started": [["trace"]],
  "execution.node.completed": [["trace"]],
  "execution.completed": [
    ["executions"],
    ["trace"],
    ["usage"],
    ["audit"]
  ],
  "execution.failed": [["executions"], ["trace"], ["usage"], ["audit"]]
};

export function EventsProvider(props: { children: React.ReactNode }) {
  const auth = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState<EventsStatus>("offline");
  const [connectionId, setConnectionId] = useState<string | null>(null);

  // Use refs for handlers + socket to avoid re-creating the WS on every
  // render. The provider re-mounts the socket only when the authenticated
  // user changes (or on explicit cleanup).
  const wsRef = useRef<WebSocket | null>(null);
  const handlers = useRef({
    events: new Set<(e: ChangeEvent) => void>(),
    roster: new Map<string, Set<(m: BuilderPresence[]) => void>>(),
    edits: new Map<string, Set<(e: BuilderEdit) => void>>()
  });
  const backoffRef = useRef(INITIAL_BACKOFF_MS);
  const reconnectTimerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  // Topics the client wants to be in after a (re)connect — re-sent on
  // reconnect so a transient drop doesn't drop the Builder room either.
  const desiredRoomsRef = useRef<Set<string>>(new Set());

  const send = useCallback((msg: WsClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        /* will be retried after reconnect */
      }
    }
  }, []);

  const onEvent: EventsApi["onEvent"] = useCallback((handler) => {
    handlers.current.events.add(handler);
    return () => {
      handlers.current.events.delete(handler);
    };
  }, []);

  const onRoster: EventsApi["onRoster"] = useCallback(
    (pipelineId, handler) => {
      const map = handlers.current.roster;
      let set = map.get(pipelineId);
      if (!set) {
        set = new Set();
        map.set(pipelineId, set);
      }
      set.add(handler);
      return () => {
        const s = map.get(pipelineId);
        if (!s) return;
        s.delete(handler);
        if (s.size === 0) map.delete(pipelineId);
      };
    },
    []
  );

  const onEdit: EventsApi["onEdit"] = useCallback((pipelineId, handler) => {
    const map = handlers.current.edits;
    let set = map.get(pipelineId);
    if (!set) {
      set = new Set();
      map.set(pipelineId, set);
    }
    set.add(handler);
    return () => {
      const s = map.get(pipelineId);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) map.delete(pipelineId);
    };
  }, []);

  // Build the WebSocket lifecycle effect. Re-runs when the authenticated
  // user changes (or logs out). On logout the socket is closed and no
  // reconnect is scheduled.
  useEffect(() => {
    if (auth.status !== "authenticated") {
      // Close any lingering socket, drop reconnect timer.
      cancelledRef.current = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          /* best-effort */
        }
        wsRef.current = null;
      }
      setStatus("offline");
      setConnectionId(null);
      return;
    }
    cancelledRef.current = false;

    function scheduleReconnect() {
      if (cancelledRef.current) return;
      const delay = backoffRef.current;
      backoffRef.current = Math.min(delay * 2, MAX_BACKOFF_MS);
      setStatus("reconnecting");
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    }

    function connect() {
      if (cancelledRef.current) return;
      setStatus("connecting");
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        const token = loadToken();
        if (!token) {
          // No credential to present — give up; the auth effect will
          // restart us when login succeeds.
          try {
            ws.close();
          } catch {
            /* best-effort */
          }
          return;
        }
        try {
          ws.send(JSON.stringify({ type: "auth", token } as WsClientMessage));
        } catch {
          /* close handler will reconnect */
        }
      });

      ws.addEventListener("message", (ev: MessageEvent<string>) => {
        let msg: WsServerMessage;
        try {
          msg = JSON.parse(ev.data) as WsServerMessage;
        } catch {
          return;
        }
        switch (msg.type) {
          case "ready":
            backoffRef.current = INITIAL_BACKOFF_MS;
            setConnectionId(msg.connectionId);
            setStatus("connected");
            // Re-establish room memberships after a reconnect.
            for (const pid of desiredRoomsRef.current) {
              try {
                ws.send(
                  JSON.stringify({
                    type: "builder:join",
                    pipelineId: pid
                  } as WsClientMessage)
                );
              } catch {
                /* will retry on next reconnect */
              }
            }
            return;
          case "event": {
            const event = msg.event;
            // Global auto-invalidation FIRST so any subscriber sees fresh
            // data when it runs.
            const targets = INVALIDATIONS[event.action];
            if (targets) {
              for (const key of targets) qc.invalidateQueries({ queryKey: key });
            }
            for (const h of [...handlers.current.events]) {
              try {
                h(event);
              } catch {
                /* handler error must not kill the socket */
              }
            }
            return;
          }
          case "builder:roster": {
            const set = handlers.current.roster.get(msg.pipelineId);
            if (set) for (const h of [...set]) h(msg.members);
            return;
          }
          case "builder:edit": {
            const set = handlers.current.edits.get(msg.pipelineId);
            if (set) for (const h of [...set]) h(msg.edit);
            return;
          }
          case "error":
            // Auth-level errors close the socket on the server side; we let
            // the close handler decide whether to reconnect.
            return;
          case "pong":
            return;
        }
      });

      ws.addEventListener("close", () => {
        if (wsRef.current === ws) wsRef.current = null;
        setConnectionId(null);
        if (!cancelledRef.current) scheduleReconnect();
      });

      ws.addEventListener("error", () => {
        try {
          ws.close();
        } catch {
          /* best-effort */
        }
      });
    }

    connect();

    return () => {
      cancelledRef.current = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          /* best-effort */
        }
        wsRef.current = null;
      }
    };
    // The connection is bound to the signed-in user's identity; re-mount
    // when that changes.
  }, [auth.status, auth.user?.id, qc]);

  // Track desired rooms so reconnects re-join automatically.
  const trackedSend = useCallback(
    (msg: WsClientMessage) => {
      if (msg.type === "builder:join") {
        desiredRoomsRef.current.add(msg.pipelineId);
      } else if (msg.type === "builder:leave") {
        desiredRoomsRef.current.delete(msg.pipelineId);
      }
      send(msg);
    },
    [send]
  );

  const api = useMemo<EventsApi>(
    () => ({
      status,
      connectionId,
      send: trackedSend,
      onEvent,
      onRoster,
      onEdit
    }),
    [status, connectionId, trackedSend, onEvent, onRoster, onEdit]
  );

  return <EventsCtx.Provider value={api}>{props.children}</EventsCtx.Provider>;
}

/**
 * Subscribe to every authorized ChangeEvent. The handler ref is kept fresh
 * across renders so callers don't have to memoise their closure.
 */
export function useChangeEvents(handler: (e: ChangeEvent) => void): void {
  const events = useEvents();
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(
    () => events.onEvent((e) => handlerRef.current(e)),
    [events]
  );
}

export interface UseBuilderRoomOptions {
  /** Called with the latest roster for the room (sender included). */
  onRoster?: (members: BuilderPresence[]) => void;
  /** Called when ANOTHER editor broadcasts a spec. */
  onEdit?: (edit: BuilderEdit) => void;
}

export interface UseBuilderRoomResult {
  status: EventsStatus;
  connectionId: string | null;
  setFocus: (nodeId: string | null) => void;
  broadcastEdit: (
    spec: unknown,
    nodeStamps?: Record<string, string>
  ) => void;
}

/**
 * Join a Builder room for the given pipeline, broadcast presence + edits,
 * and surface roster/edit callbacks. When `pipelineId` is undefined no room
 * is joined (so the hook is safe to call before the URL param is known).
 */
export function useBuilderRoom(
  pipelineId: string | undefined,
  options: UseBuilderRoomOptions = {}
): UseBuilderRoomResult {
  const events = useEvents();
  const rosterRef = useRef(options.onRoster);
  const editRef = useRef(options.onEdit);
  useEffect(() => {
    rosterRef.current = options.onRoster;
    editRef.current = options.onEdit;
  });

  useEffect(() => {
    if (!pipelineId) return;
    events.send({ type: "builder:join", pipelineId });
    const offRoster = events.onRoster(pipelineId, (m) =>
      rosterRef.current?.(m)
    );
    const offEdit = events.onEdit(pipelineId, (e) => editRef.current?.(e));
    return () => {
      events.send({ type: "builder:leave", pipelineId });
      offRoster();
      offEdit();
    };
  }, [events, pipelineId]);

  const setFocus = useCallback(
    (nodeId: string | null) => {
      if (!pipelineId) return;
      events.send({
        type: "builder:presence",
        pipelineId,
        focusNodeId: nodeId
      });
    },
    [events, pipelineId]
  );

  const broadcastEdit = useCallback(
    (spec: unknown, nodeStamps?: Record<string, string>) => {
      if (!pipelineId) return;
      events.send({
        type: "builder:edit",
        pipelineId,
        spec,
        nodeStamps
      });
    },
    [events, pipelineId]
  );

  return {
    status: events.status,
    connectionId: events.connectionId,
    setFocus,
    broadcastEdit
  };
}

/** Tiny indicator string for the sidebar (live / reconnecting / offline). */
export function statusLabel(s: EventsStatus): string {
  switch (s) {
    case "connected":
      return "live";
    case "connecting":
      return "connecting";
    case "reconnecting":
      return "reconnecting";
    case "offline":
      return "offline";
  }
}
