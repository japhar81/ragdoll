import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import { Screen, Table } from "./Screen.tsx";

/**
 * Executions admin. Lists GET /api/executions; selecting one fetches
 * GET /api/executions/{id}/trace and renders a node-level timeline with
 * latency / status / error.
 */
export function ExecutionsScreen() {
  const [selected, setSelected] = useState<string | undefined>();

  const executions = useQuery({
    queryKey: ["executions"],
    queryFn: () => api.listExecutions()
  });

  const trace = useQuery({
    queryKey: ["trace", selected],
    queryFn: () => api.getTrace(selected as string),
    enabled: Boolean(selected)
  });

  return (
    <Screen
      title="Executions"
      isLoading={executions.isLoading}
      error={executions.error}
    >
      <Table
        columns={["", "Execution", "Pipeline", "Status", "Started", "Completed"]}
        rows={(executions.data?.executions ?? []).map((ex) => [
          <button key={ex.executionId} onClick={() => setSelected(ex.executionId)}>
            View trace
          </button>,
          ex.executionId,
          ex.pipelineId,
          <span className={`status status-${ex.status}`}>{ex.status}</span>,
          ex.startedAt,
          ex.completedAt ?? "-"
        ])}
      />

      {selected && (
        <>
          <h2>Trace: {selected}</h2>
          {trace.isLoading && <p className="muted">Loading trace…</p>}
          {trace.error && <p className="error">{String(trace.error)}</p>}
          {trace.data && (
            <>
              {trace.data.execution.error && (
                <p className="error">Execution error: {trace.data.execution.error}</p>
              )}
              <ol className="timeline">
                {trace.data.nodes.map((n) => (
                  <li key={n.nodeId} className={`status-${n.status}`}>
                    <strong>{n.nodeId}</strong>
                    <span className={`status status-${n.status}`}>{n.status}</span>
                    <span className="muted">
                      {n.latencyMs !== undefined
                        ? `${Math.round(n.latencyMs)} ms`
                        : "—"}
                    </span>
                    {n.error && <div className="error">{n.error}</div>}
                  </li>
                ))}
                {trace.data.nodes.length === 0 && (
                  <li className="muted">No node records yet (run in worker pending).</li>
                )}
              </ol>
            </>
          )}
        </>
      )}
    </Screen>
  );
}
