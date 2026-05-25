import React, { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import type { UsageRow } from "../lib/api.ts";
import { Screen } from "./Screen.tsx";
import { SvarDataGrid, type SvarColumn } from "./SvarDataGrid.tsx";

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
      <SvarDataGrid<UsageRow>
        columns={
          [
            {
              id: "executionId",
              header: "Execution",
              width: 180,
              cell: (r) =>
                r.executionId ? <code>{r.executionId.slice(0, 12)}…</code> : "—"
            },
            {
              id: "tenantId",
              header: "Tenant",
              cell: (r) =>
                r.tenantId ? <code>{r.tenantId.slice(0, 8)}…</code> : "—"
            },
            {
              id: "inputTokens",
              header: "Input",
              width: 100,
              align: "right"
            },
            {
              id: "outputTokens",
              header: "Output",
              width: 100,
              align: "right"
            },
            {
              id: "embeddingTokens",
              header: "Embedding",
              width: 110,
              align: "right"
            },
            {
              id: "estimatedCostUsd",
              header: "Cost",
              width: 110,
              align: "right",
              cell: (r) => `$${r.estimatedCostUsd.toFixed(4)}`
            }
          ] satisfies SvarColumn<UsageRow>[]
        }
        rows={records}
        rowKey={(r) => `${r.executionId ?? "no-exec"}-${r.id ?? ""}`}
        height="calc(100vh - 320px)"
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
