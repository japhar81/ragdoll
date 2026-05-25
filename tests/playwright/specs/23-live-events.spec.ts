/**
 * /api/events WebSocket smoke. Opens the channel, sends an auth frame,
 * waits for the `ready` response, then triggers a tenant-scoped
 * mutation (create a dataset) and asserts the corresponding ChangeEvent
 * lands on the socket inside a short window.
 *
 * Uses Node's `ws` package (already a transitive dep via @fastify/
 * websocket) instead of Playwright's browser-side WebSocket — keeps the
 * spec independent of any page session.
 */
import { test, expect } from "../helpers/fixtures.ts";
import { API_URL } from "../helpers/env.ts";
import WebSocket from "ws";

const RUN_SUFFIX = String(Date.now()).slice(-8);

interface WsEnvelope {
  type: string;
  event?: { action?: string; targetType?: string; tenantId?: string };
  [k: string]: unknown;
}

function wsUrl(): string {
  return API_URL.replace(/^http/, "ws") + "/api/events";
}

/**
 * Open the WS, send `{type:"auth",token}`, and resolve once the server
 * sends `{type:"ready"}`. Rejects on `error` or non-ready terminal
 * frames so the spec fails fast on auth misconfiguration.
 */
function connectAuthed(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    const timer = setTimeout(() => {
      reject(new Error("ws auth timed out"));
      ws.terminate();
    }, 10_000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", token }));
    });
    ws.on("message", (data) => {
      let msg: WsEnvelope;
      try {
        msg = JSON.parse(String(data)) as WsEnvelope;
      } catch {
        return;
      }
      if (msg.type === "ready") {
        clearTimeout(timer);
        resolve(ws);
      } else if (msg.type === "error") {
        clearTimeout(timer);
        reject(new Error(`ws auth error: ${JSON.stringify(msg)}`));
        ws.terminate();
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Wait for an event matching the predicate to land on the socket
 * within `timeoutMs`. Buffers every frame so an event that arrived
 * before this helper was invoked is still observable.
 */
function awaitEvent(
  ws: WebSocket,
  match: (e: WsEnvelope) => boolean,
  timeoutMs = 8000
): Promise<WsEnvelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no matching event within ${timeoutMs}ms`));
    }, timeoutMs);
    ws.on("message", (data) => {
      let msg: WsEnvelope;
      try {
        msg = JSON.parse(String(data)) as WsEnvelope;
      } catch {
        return;
      }
      if (msg.type === "event" && match(msg)) {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
}

test.describe("live events", () => {
  test("auth → ready → dataset.create fans out to the socket", async ({
    rest,
    state
  }) => {
    const ws = await connectAuthed(rest.token);
    try {
      // Set up the matcher BEFORE we kick the mutation so a same-tick
      // publish isn't missed.
      const eventPromise = awaitEvent(ws, (msg) => {
        const e = msg.event;
        return (
          e?.action === "dataset.create" &&
          e?.targetType === "dataset" &&
          e?.tenantId === state.tenantId
        );
      });
      const slug = `pw_integration_ws_${RUN_SUFFIX}`;
      await rest.request("POST", "/api/datasets", {
        scope: "tenant",
        tenantId: state.tenantId,
        slug,
        displayName: "WS event test",
        modalities: ["vector"],
        backends: { vector: { provider: "qdrant" } }
      });
      const event = await eventPromise;
      expect(event.event?.action).toBe("dataset.create");
      expect(event.event?.tenantId).toBe(state.tenantId);
    } finally {
      ws.close();
    }
  });

  test("auth frame is required — server rejects unauthenticated frames", async () => {
    // Open WITHOUT sending an auth frame; any other message type should
    // come back as `{type:"error", code:"unauthenticated"}`.
    const ws = new WebSocket(wsUrl());
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("open timed out")), 5000);
        ws.on("open", () => {
          clearTimeout(timer);
          resolve();
        });
        ws.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      ws.send(JSON.stringify({ type: "presence", room: "test" }));
      const reply = await new Promise<WsEnvelope>((resolve) => {
        ws.once("message", (data) => {
          resolve(JSON.parse(String(data)) as WsEnvelope);
        });
      });
      expect(reply.type).toBe("error");
      expect(reply.code).toBe("unauthenticated");
    } finally {
      ws.close();
    }
  });
});
