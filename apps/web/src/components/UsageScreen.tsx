import React, { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import type { UsageRow } from "../lib/api.ts";
import { Screen } from "./Screen.tsx";
import { DataGrid, type DataGridColumn } from "./DataGrid.tsx";

/** Usage admin. GET /api/usage returns an aggregated summary + raw records. */
export function UsageScreen() {
  const usage = useInfiniteQuery({
    queryKey: ["usage", "page"],
    queryFn: ({ pageParam }) =>
      api.usage({
        limit: 50,
        ...(typeof pageParam === "string" ? { cursor: pageParam } : {})
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined
  });
  const records = useMemo(
    () => usage.data?.pages.flatMap((p) => p.records) ?? [],
    [usage.data]
  );
  // Summary across all loaded pages. The API returns a per-page summary
  // (paginated path), so we re-fold rows here as new pages arrive.
  const s = useMemo(
    () =>
      records.reduce<{
        count: number;
        inputTokens: number;
        outputTokens: number;
        embeddingTokens: number;
        estimatedCostUsd: number;
      }>(
        (acc, r) => {
          acc.count += 1;
          acc.inputTokens += r.inputTokens;
          acc.outputTokens += r.outputTokens;
          acc.embeddingTokens += r.embeddingTokens;
          acc.estimatedCostUsd += r.estimatedCostUsd;
          return acc;
        },
        {
          count: 0,
          inputTokens: 0,
          outputTokens: 0,
          embeddingTokens: 0,
          estimatedCostUsd: 0
        }
      ),
    [records]
  );

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
        rows={records}
        rowKey={(r, i) => `${r.executionId ?? "no-exec"}-${i}`}
        emptyMessage="No usage records yet."
        hasMore={usage.hasNextPage}
        isLoadingMore={usage.isFetchingNextPage}
        onLoadMore={() => {
          if (usage.hasNextPage && !usage.isFetchingNextPage) {
            void usage.fetchNextPage();
          }
        }}
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
