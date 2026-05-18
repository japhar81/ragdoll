import React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import { Screen, Table } from "./Screen.tsx";

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
      <Table
        columns={["Execution", "Tenant", "Input", "Output", "Embedding", "Cost"]}
        rows={(usage.data?.records ?? []).map((r) => [
          r.executionId ?? "-",
          r.tenantId ?? "-",
          r.inputTokens,
          r.outputTokens,
          r.embeddingTokens,
          `$${r.estimatedCostUsd.toFixed(4)}`
        ])}
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
