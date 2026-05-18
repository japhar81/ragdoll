import React, { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PipelineBuilder } from "./components/PipelineBuilder.tsx";
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
  | "builder"
  | "tenants"
  | "config"
  | "secrets"
  | "executions"
  | "audit"
  | "usage";

const NAV: Array<{ id: View; label: string }> = [
  { id: "builder", label: "Pipeline Builder" },
  { id: "tenants", label: "Tenants" },
  { id: "config", label: "Config" },
  { id: "secrets", label: "Secrets" },
  { id: "executions", label: "Executions" },
  { id: "audit", label: "Audit" },
  { id: "usage", label: "Usage" }
];

export default function App() {
  const [view, setView] = useState<View>("builder");
  return (
    <QueryClientProvider client={queryClient}>
      <main className="app-shell">
        <aside className="sidebar">
          <h1>RAGdoll</h1>
          <nav>
            {NAV.map((item) => (
              <a
                key={item.id}
                className={view === item.id ? "active" : undefined}
                onClick={() => setView(item.id)}
              >
                {item.label}
              </a>
            ))}
          </nav>
        </aside>
        {view === "builder" && <PipelineBuilder />}
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
