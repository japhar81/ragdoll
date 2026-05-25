import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import type { AuditRow } from "../lib/api.ts";
import { Screen } from "./Screen.tsx";
import { DataGrid, type DataGridColumn } from "./DataGrid.tsx";

/** Audit admin. GET /api/audit returns the redacted audit log list. */
export function AuditScreen() {
  const audit = useQuery({
    queryKey: ["audit"],
    queryFn: () => api.listAudit({ limit: 200 })
  });

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
        rows={audit.data?.logs ?? []}
        rowKey={(l, i) => `${l.createdAt}-${l.targetId}-${i}`}
        emptyMessage="No audit entries."
      />
    </Screen>
  );
}
