import React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import { Screen, Table } from "./Screen.tsx";

/** Audit admin. GET /api/audit returns the redacted audit log list. */
export function AuditScreen() {
  const audit = useQuery({
    queryKey: ["audit"],
    queryFn: () => api.listAudit({ limit: 200 })
  });

  return (
    <Screen title="Audit Log" isLoading={audit.isLoading} error={audit.error}>
      <Table
        columns={["Time", "Actor", "Tenant", "Action", "Target", "Target ID"]}
        rows={(audit.data?.logs ?? []).map((l) => [
          l.createdAt,
          l.actorId,
          l.tenantId ?? "-",
          l.action,
          l.targetType,
          l.targetId
        ])}
      />
    </Screen>
  );
}
