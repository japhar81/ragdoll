import React, { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PipelineBuilder } from "./components/PipelineBuilder.tsx";
import { PipelinesScreen } from "./components/PipelinesScreen.tsx";
import { SchedulerScreen } from "./components/SchedulerScreen.tsx";
import { TenantsScreen } from "./components/TenantsScreen.tsx";
import { ConfigScreen } from "./components/ConfigScreen.tsx";
import { SecretsScreen } from "./components/SecretsScreen.tsx";
import { ExecutionsScreen } from "./components/ExecutionsScreen.tsx";
import { UsageScreen } from "./components/UsageScreen.tsx";
import { AuditScreen } from "./components/AuditScreen.tsx";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } }
});

type View =
  | "pipelines"
  | "builder"
  | "scheduler"
  | "tenants"
  | "config"
  | "secrets"
  | "executions"
  | "audit"
  | "usage";

const NAV_GROUPS: Array<{ group: string; items: Array<{ id: View; label: string }> }> = [
  {
    group: "Build",
    items: [
      { id: "pipelines", label: "Pipelines" },
      { id: "builder", label: "Builder" },
      { id: "scheduler", label: "Scheduler" }
    ]
  },
  {
    group: "Operate",
    items: [
      { id: "executions", label: "Executions" },
      { id: "usage", label: "Usage" },
      { id: "audit", label: "Audit" }
    ]
  },
  {
    group: "Govern",
    items: [
      { id: "tenants", label: "Tenants" },
      { id: "config", label: "Config" },
      { id: "secrets", label: "Secrets" }
    ]
  }
];

/**
 * App-level bridge so the Pipelines tree can hand a specific pipeline to the
 * Builder. `openInBuilder(id, name)` stashes the id, switches the view, and
 * the Builder loads that pipeline's latest version on mount/prop-change.
 */
export interface EditingPipeline {
  id: string;
  name: string;
}

export default function App() {
  const [view, setView] = useState<View>("pipelines");
  const [editing, setEditing] = useState<EditingPipeline | undefined>();

  function openInBuilder(pipeline: EditingPipeline): void {
    setEditing(pipeline);
    setView("builder");
  }

  return (
    <QueryClientProvider client={queryClient}>
      <main className="app-shell">
        <aside className="sidebar">
          <h1>RAGdoll</h1>
          <nav>
            {NAV_GROUPS.map((g) => (
              <React.Fragment key={g.group}>
                <span className="nav-group">{g.group}</span>
                {g.items.map((item) => (
                  <a
                    key={item.id}
                    className={view === item.id ? "active" : undefined}
                    onClick={() => setView(item.id)}
                  >
                    {item.label}
                  </a>
                ))}
              </React.Fragment>
            ))}
          </nav>
        </aside>
        {view === "pipelines" && (
          <PipelinesScreen onEditPipeline={openInBuilder} />
        )}
        {view === "builder" && (
          <PipelineBuilder
            editing={editing}
            onClearEditing={() => setEditing(undefined)}
          />
        )}
        {view === "scheduler" && <SchedulerScreen />}
        {view === "tenants" && <TenantsScreen />}
        {view === "config" && <ConfigScreen />}
        {view === "secrets" && <SecretsScreen />}
        {view === "executions" && <ExecutionsScreen />}
        {view === "audit" && <AuditScreen />}
        {view === "usage" && <UsageScreen />}
      </main>
    </QueryClientProvider>
  );
}
