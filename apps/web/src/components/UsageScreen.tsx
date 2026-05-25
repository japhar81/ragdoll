import React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import type { UsageRow } from "../lib/api.ts";
import { Screen } from "./Screen.tsx";
import { DataGrid, type DataGridColumn } from "./DataGrid.tsx";

/** Usage admin. GET /api/usage returns an aggregated summary + raw records. */
export function UsageScreen() {
  const usage = useQuery({
    queryKey: ["usage"],
    queryFn: () => api.usage()
  });

  const s = usage.data?.summary;

  return (
    <Screen title="Usage & Cost" isLoading={usage.isLoading} error={usage.error}>
      <div className="metric-row">
        <Metric label="Executions" value={s?.count ?? 0} />
        <Metric label="Input tokens" value={s?.inputTokens ?? 0} />
        <Metric label="Output tokens" value={s?.outputTokens ?? 0} />
        <Metric label="Embedding tokens" value={s?.embeddingTokens ?? 0} />
        <Metric
          label="Est. cost (USD)"
          value={`$${(s?.estimatedCostUsd ?? 0).toFixed(4)}`}
        />
      </div>
      <h2>Records</h2>
      <DataGrid<UsageRow>
        columns={
          [
            {
              key: "executionId",
              header: "Execution",
              accessor: (r) => r.executionId ?? "—",
              cell: (r) =>
                r.executionId ? <code>{r.executionId.slice(0, 12)}…</code> : "—",
              width: "20%"
            },
            {
              key: "tenantId",
              header: "Tenant",
              accessor: (r) => r.tenantId ?? "—",
              filter: "select",
              width: "20%"
            },
            {
              key: "inputTokens",
              header: "Input",
              accessor: (r) => r.inputTokens,
              align: "right",
              width: "12%"
            },
            {
              key: "outputTokens",
              header: "Output",
              accessor: (r) => r.outputTokens,
              align: "right",
              width: "12%"
            },
            {
              key: "embeddingTokens",
              header: "Embedding",
              accessor: (r) => r.embeddingTokens,
              align: "right",
              width: "12%"
            },
            {
              key: "cost",
              header: "Cost",
              accessor: (r) => r.estimatedCostUsd,
              cell: (r) => `$${r.estimatedCostUsd.toFixed(4)}`,
              align: "right",
              width: "12%"
            }
          ] satisfies DataGridColumn<UsageRow>[]
        }
        rows={usage.data?.records ?? []}
        rowKey={(r, i) => `${r.executionId ?? "no-exec"}-${i}`}
        emptyMessage="No usage records yet."
      />
    </Screen>
  );
}

function Metric(props: { label: string; value: React.ReactNode }) {
  return (
    <div className="metric">
      <div className="metric-value">{props.value}</div>
      <div className="metric-label">{props.label}</div>
    </div>
  );
}
