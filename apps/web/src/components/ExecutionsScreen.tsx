import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import { Screen, Table } from "./Screen.tsx";
import {
  isTerminalStatus,
  sampleForDisplay,
  summarizeExecution
} from "../lib/execTrace.ts";
import { useEvents } from "../events/EventsProvider.tsx";
import type { ExecutionNodeRecord } from "../lib/types.ts";

/**
 * Executions admin. Lists GET /api/executions; selecting one fetches
 * GET /api/executions/{id}/trace and renders a header summary, Input/Output
 * (sampled) or a prominent Error block, and a node-level timeline with
 * latency / status / expandable sampled Input+Output / error.
 *
 * Live updates ride the `/api/events` WebSocket: the worker publishes
 * `execution.*` events which the EventsProvider invalidates into this
 * screen's queries, so node transitions and the terminal state appear
 * within a frame. When the socket is offline (initial connect, reconnect,
 * or a missing credential) the trace query falls back to a slow poll so
 * progress still shows up. Polling stops once the execution is terminal.
 */
const TRACE_POLL_MS = 1500;

function pretty(value: unknown): string {
  try {
    return JSON.stringify(sampleForDisplay(value), null, 2);
  } catch {
    return String(value);
  }
}

function NodeRow(props: { node: ExecutionNodeRecord }) {
  const { node } = props;
  const [open, setOpen] = useState(false);
  const hasIO =
    node.input !== undefined ||
    node.output !== undefined ||
    Boolean(node.error);
  return (
    <li className={`status-${node.status}`}>
      <div className="exec-node-line">
        <button
          type="button"
          className="link-btn"
          onClick={() => hasIO && setOpen((v) => !v)}
          title={hasIO ? "Toggle node input/output" : undefined}
          style={{ cursor: hasIO ? "pointer" : "default" }}
        >
          {hasIO ? (open ? "▾" : "▸") : "•"} <strong>{node.nodeId}</strong>
        </button>
        <span className={`status status-${node.status}`}>{node.status}</span>
        <span className="muted">
          {node.latencyMs !== undefined
            ? `${Math.round(node.latencyMs)} ms`
            : node.status === "running"
              ? "running…"
              : "—"}
        </span>
      </div>
      {node.error && <div className="error">{node.error}</div>}
      {open && hasIO && (
        <div className="exec-io">
          {node.input !== undefined && (
            <>
              <div className="muted">input</div>
              <pre className="console-detail">{pretty(node.input)}</pre>
            </>
          )}
          {node.output !== undefined && (
            <>
              <div className="muted">output</div>
              <pre className="console-detail">{pretty(node.output)}</pre>
            </>
          )}
        </div>
      )}
    </li>
  );
}

export function ExecutionsScreen() {
  const [selected, setSelected] = useState<string | undefined>();
  const events = useEvents();
  // When the live socket is connected, lean on event-driven invalidation
  // (the EventsProvider maps `execution.*` events onto these query keys).
  // Fall back to polling only while disconnected.
  const liveConnected = events.status === "connected";

  const executions = useQuery({
    queryKey: ["executions"],
    queryFn: () => api.listExecutions()
  });

  const trace = useQuery({
    queryKey: ["trace", selected],
    queryFn: () => api.getExecutionTrace(selected as string),
    enabled: Boolean(selected),
    // Live-update while the selected execution is still running; stop on
    // terminal so a finished execution isn't re-fetched forever. Once the
    // WS is connected, events drive the refresh and we skip the timer.
    refetchInterval: (query) => {
      if (liveConnected) return false;
      const status = query.state.data?.execution?.status;
      return status && isTerminalStatus(status) ? false : TRACE_POLL_MS;
    }
  });

  const ex = trace.data?.execution;
  const summary = ex ? summarizeExecution(ex) : undefined;

  return (
    <Screen
      title="Executions"
      isLoading={executions.isLoading}
      error={executions.error}
    >
      <Table
        columns={["", "Execution", "Pipeline", "Status", "Started", "Completed"]}
        rows={(executions.data?.executions ?? []).map((e) => [
          <button key={e.executionId} onClick={() => setSelected(e.executionId)}>
            {selected === e.executionId ? "Viewing" : "View trace"}
          </button>,
          e.executionId,
          e.pipelineId,
          <span className={`status status-${e.status}`}>{e.status}</span>,
          e.startedAt,
          e.completedAt ?? "-"
        ])}
      />

      {selected && (
        <section className="exec-detail">
          <h2>
            Execution {selected}{" "}
            {ex && (
              <span className={`status status-${ex.status}`}>{ex.status}</span>
            )}
            {summary && !summary.terminal && (
              <span className="muted">
                {" "}
                · live ({liveConnected ? "streaming" : "polling"}…)
              </span>
            )}
          </h2>
          {trace.isLoading && <p className="muted">Loading trace…</p>}
          {trace.error && <p className="error">{String(trace.error)}</p>}
          {trace.data && ex && (
            <>
              <div className="metric-row">
                <div className="metric">
                  <div className="muted">Status</div>
                  <div>{summary?.line ?? ex.status}</div>
                </div>
                <div className="metric">
                  <div className="muted">Started</div>
                  <div>{ex.startedAt}</div>
                </div>
                <div className="metric">
                  <div className="muted">Completed</div>
                  <div>{ex.completedAt ?? "—"}</div>
                </div>
                <div className="metric">
                  <div className="muted">Pipeline / Version</div>
                  <div>
                    {ex.pipelineId}
                    <br />
                    {ex.pipelineVersionId}
                  </div>
                </div>
                <div className="metric">
                  <div className="muted">Tenant</div>
                  <div>{ex.tenantId}</div>
                </div>
              </div>

              {ex.error ? (
                <div className="exec-block">
                  <h3 className="error">Error</h3>
                  <pre className="console-detail">{ex.error}</pre>
                </div>
              ) : null}

              {ex.input !== undefined && (
                <div className="exec-block">
                  <h3>Input</h3>
                  <pre className="console-detail">{pretty(ex.input)}</pre>
                </div>
              )}
              {ex.output !== undefined && (
                <div className="exec-block">
                  <h3>Output</h3>
                  <pre className="console-detail">{pretty(ex.output)}</pre>
                </div>
              )}

              <h3>Node timeline</h3>
              <ol className="timeline">
                {trace.data.nodes.map((n) => (
                  <NodeRow key={`${n.nodeId}-${n.status}`} node={n} />
                ))}
                {trace.data.nodes.length === 0 && (
                  <li className="muted">
                    No node records yet (worker run pending) — polling…
                  </li>
                )}
              </ol>
            </>
          )}
        </section>
      )}
    </Screen>
  );
}
