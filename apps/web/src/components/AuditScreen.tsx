import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import type { AuditRow } from "../lib/api.ts";
import { useLookups } from "../lib/lookups.ts";
import { Screen } from "./Screen.tsx";
import { SvarDataGrid, type SvarColumn } from "./SvarDataGrid.tsx";

/** Audit admin. GET /api/audit returns the redacted audit log list. */
export function AuditScreen() {
  const lookups = useLookups();
  const audit = useInfiniteQuery({
    queryKey: ["audit", "page"],
    queryFn: ({ pageParam }) =>
      api.listAudit({
        limit: 50,
        ...(typeof pageParam === "string" ? { cursor: pageParam } : {})
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined
  });
  const rows = useMemo(
    () => audit.data?.pages.flatMap((p) => p.logs) ?? [],
    [audit.data]
  );
  // The total is the same for every page (filter doesn't change with
  // the cursor), so pluck it off the first one.
  const totalRows = audit.data?.pages[0]?.total;

  // When the audit row's targetType is "pipeline", the targetId is a
  // pipeline uuid we can render as a friendly name. Anything else (user,
  // role, secret, …) stays as the raw id — those have no shared lookup.
  const targetLabel = (l: AuditRow): string => {
    if (l.targetType === "pipeline") return lookups.pipelineLabel(l.targetId);
    if (l.targetType === "tenant") return lookups.tenantLabel(l.targetId);
    return l.targetId;
  };

  const columns: SvarColumn<AuditRow>[] = [
    {
      id: "createdAt",
      header: "Time",
      cell: (l) => new Date(l.createdAt).toLocaleString(),
      measure: (l) => new Date(l.createdAt).toLocaleString()
    },
    {
      id: "actorId",
      header: "Actor",
      cell: (l) => l.actorId ?? "—",
      measure: (l) => l.actorId ?? "—"
    },
    {
      id: "tenant",
      header: "Tenant",
      cell: (l) =>
        l.tenantId ? (
          <span title={l.tenantId} className="cell-name">
            {lookups.tenantLabel(l.tenantId)}
          </span>
        ) : (
          "—"
        ),
      measure: (l) => (l.tenantId ? lookups.tenantLabel(l.tenantId) : "—")
    },
    { id: "action", header: "Action" },
    { id: "targetType", header: "Target type" },
    {
      id: "targetId",
      header: "Target",
      cell: (l) => (
        <span title={l.targetId} className="cell-name">
          {targetLabel(l)}
        </span>
      ),
      measure: (l) => targetLabel(l)
    }
  ];

  return (
    <Screen
      title="Audit Log"
      isLoading={audit.isLoading}
      error={audit.error}
      fill
    >
      <SvarDataGrid<AuditRow>
        columns={columns}
        rows={rows}
        rowKey={(l) => `${l.createdAt}-${l.targetId}`}
        emptyMessage="No audit entries."
        rowNoun="audit entry"
        totalRows={totalRows}
        hasMore={audit.hasNextPage}
        isLoadingMore={audit.isFetchingNextPage}
        onLoadMore={() => {
          if (audit.hasNextPage && !audit.isFetchingNextPage) {
            void audit.fetchNextPage();
          }
        }}
      />
    </Screen>
  );
}
