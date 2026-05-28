import React, { useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import type { UsageRow } from "../lib/api.ts";
import type { ExecutionRecord } from "../lib/types.ts";
import { useLookups } from "../lib/lookups.ts";
import { Screen } from "./Screen.tsx";
import { SvarDataGrid, type SvarColumn } from "./SvarDataGrid.tsx";

/** Usage admin. GET /api/usage returns an aggregated summary + raw records. */
export function UsageScreen() {
  const lookups = useLookups();
  // Usage rows only carry `executionId` + `tenantId` — pipelineId is not in
  // the wire shape today. We fetch the most recent executions page (default
  // 50) and build an id→pipeline lookup so the table can show a pipeline
  // name for rows whose execution is on that page. Anything older shows
  // "—" rather than a truncated UUID; the per-execution drill-down still
  // works from the executions screen.
  const recentExecutions = useQuery({
    queryKey: ["usage", "recent-executions"],
    queryFn: () => api.listExecutions({ limit: 50 }),
    staleTime: 30_000
  });
  const execIndex = useMemo(() => {
    const map = new Map<string, ExecutionRecord>();
    for (const e of recentExecutions.data?.executions ?? []) {
      map.set(e.executionId, e);
    }
    return map;
  }, [recentExecutions.data]);

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
  const totalUsage = usage.data?.pages[0]?.total;
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
    <Screen
      title="Usage & Cost"
      isLoading={usage.isLoading}
      error={usage.error}
      fill
    >
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
              cell: (r) =>
                r.executionId ? (
                  <code title={r.executionId} className="cell-mono">
                    {r.executionId}
                  </code>
                ) : (
                  "—"
                )
            },
            {
              id: "pipeline",
              header: "Pipeline",
              cell: (r) => {
                const ex = r.executionId ? execIndex.get(r.executionId) : undefined;
                if (!ex) return <span className="muted">—</span>;
                return (
                  <span title={ex.pipelineId} className="cell-name">
                    {lookups.pipelineLabel(ex.pipelineId)}
                  </span>
                );
              }
            },
            {
              id: "tenant",
              header: "Tenant",
              cell: (r) =>
                r.tenantId ? (
                  <span title={r.tenantId} className="cell-name">
                    {lookups.tenantLabel(r.tenantId)}
                  </span>
                ) : (
                  "—"
                )
            },
            {
              id: "environment",
              header: "Environment",
              width: 120,
              cell: (r) => {
                const ex = r.executionId ? execIndex.get(r.executionId) : undefined;
                return ex?.environment ?? "—";
              }
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
        rowKey={(r) =>
          `${r.executionId ?? "no-exec"}-${r.inputTokens}-${r.outputTokens}`
        }
        emptyMessage="No usage records yet."
        rowNoun="usage record"
        totalRows={totalUsage}
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
