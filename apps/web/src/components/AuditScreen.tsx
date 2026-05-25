import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import type { AuditRow } from "../lib/api.ts";
import { Screen } from "./Screen.tsx";
import { SvarDataGrid, type SvarColumn } from "./SvarDataGrid.tsx";

/** Audit admin. GET /api/audit returns the redacted audit log list. */
export function AuditScreen() {
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

  const columns: SvarColumn<AuditRow>[] = [
    {
      id: "createdAt",
      header: "Time",
      width: 180,
      cell: (l) => new Date(l.createdAt).toLocaleString()
    },
    {
      id: "actorId",
      header: "Actor",
      cell: (l) => l.actorId ?? "—"
    },
    {
      id: "tenantId",
      header: "Tenant",
      cell: (l) =>
        l.tenantId ? <code>{l.tenantId.slice(0, 8)}…</code> : "—"
    },
    { id: "action", header: "Action" },
    { id: "targetType", header: "Target type" },
    {
      id: "targetId",
      header: "Target ID",
      cell: (l) => <code>{l.targetId}</code>
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
