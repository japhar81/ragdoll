import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import type { AuditRow } from "../lib/api.ts";
import { Screen } from "./Screen.tsx";
import { DataGrid, type DataGridColumn } from "./DataGrid.tsx";

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

  const columns: DataGridColumn<AuditRow>[] = [
    {
      key: "time",
      header: "Time",
      accessor: (l) => l.createdAt,
      cell: (l) => new Date(l.createdAt).toLocaleString(),
      width: "16%"
    },
    { key: "actor", header: "Actor", accessor: (l) => l.actorId ?? "—", width: "18%" },
    {
      key: "tenant",
      header: "Tenant",
      accessor: (l) => l.tenantId ?? "—",
      filter: "select",
      width: "14%"
    },
    {
      key: "action",
      header: "Action",
      accessor: (l) => l.action,
      filter: "select",
      width: "18%"
    },
    {
      key: "targetType",
      header: "Target type",
      accessor: (l) => l.targetType,
      filter: "select",
      width: "14%"
    },
    {
      key: "targetId",
      header: "Target ID",
      accessor: (l) => l.targetId,
      cell: (l) => <code>{l.targetId}</code>,
      width: "20%"
    }
  ];

  return (
    <Screen title="Audit Log" isLoading={audit.isLoading} error={audit.error}>
      <DataGrid
        columns={columns}
        rows={rows}
        rowKey={(l, i) => `${l.createdAt}-${l.targetId}-${i}`}
        emptyMessage="No audit entries."
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
