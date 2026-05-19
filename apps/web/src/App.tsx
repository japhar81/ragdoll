import React, { useMemo, useState } from "react";
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
import { UsersScreen } from "./components/UsersScreen.tsx";
import { RolesScreen } from "./components/RolesScreen.tsx";
import { IdentityProvidersScreen } from "./components/IdentityProvidersScreen.tsx";
import { AuthSettingsScreen } from "./components/AuthSettingsScreen.tsx";
import { LoginScreen } from "./components/LoginScreen.tsx";
import { AuthProvider, useAuth } from "./auth/AuthContext.tsx";
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
  | "usage"
  | "users"
  | "roles"
  | "identity-providers"
  | "auth-settings";

/** Each item lists the permissions that make it visible (any-of). An empty
 * list means always visible to any authenticated user. */
const NAV_GROUPS: Array<{
  group: string;
  items: Array<{ id: View; label: string; perms: string[] }>;
}> = [
  {
    group: "Build",
    items: [
      { id: "pipelines", label: "Pipelines", perms: ["execution:view_logs", "pipeline:create", "pipeline:update"] },
      { id: "builder", label: "Builder", perms: ["pipeline:create", "pipeline:update"] },
      { id: "scheduler", label: "Scheduler", perms: ["pipeline:run", "config:edit_tenant"] }
    ]
  },
  {
    group: "Operate",
    items: [
      { id: "executions", label: "Executions", perms: ["execution:view_logs"] },
      { id: "usage", label: "Usage", perms: ["execution:view_logs"] },
      { id: "audit", label: "Audit", perms: ["audit:view"] }
    ]
  },
  {
    group: "Govern",
    items: [
      { id: "tenants", label: "Tenants", perms: ["config:edit_global"] },
      { id: "config", label: "Config", perms: ["config:edit_global", "config:edit_tenant", "config:edit_pipeline"] },
      { id: "secrets", label: "Secrets", perms: ["secret:manage_tenant"] }
    ]
  },
  {
    group: "Access",
    items: [
      { id: "users", label: "Users", perms: ["user:manage"] },
      { id: "roles", label: "Roles & Permissions", perms: ["role:manage"] },
      { id: "identity-providers", label: "Identity Providers", perms: ["idp:manage"] },
      { id: "auth-settings", label: "Auth Settings", perms: ["auth:settings"] }
    ]
  }
];

export interface EditingPipeline {
  id: string;
  name: string;
}

function Shell() {
  const auth = useAuth();
  const [editing, setEditing] = useState<EditingPipeline | undefined>();

  // Only show nav items the user can act on (the server still enforces).
  const groups = useMemo(
    () =>
      NAV_GROUPS.map((g) => ({
        group: g.group,
        items: g.items.filter(
          (it) => it.perms.length === 0 || auth.can(...it.perms)
        )
      })).filter((g) => g.items.length > 0),
    [auth]
  );

  const firstView = groups[0]?.items[0]?.id;
  const [view, setView] = useState<View | undefined>(firstView);
  const current =
    view && groups.some((g) => g.items.some((i) => i.id === view))
      ? view
      : firstView;

  function openInBuilder(pipeline: EditingPipeline): void {
    setEditing(pipeline);
    setView("builder");
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <h1>RAGdoll</h1>
        <nav>
          {groups.map((g) => (
            <React.Fragment key={g.group}>
              <span className="nav-group">{g.group}</span>
              {g.items.map((item) => (
                <a
                  key={item.id}
                  className={current === item.id ? "active" : undefined}
                  onClick={() => setView(item.id)}
                >
                  {item.label}
                </a>
              ))}
            </React.Fragment>
          ))}
        </nav>
        <div className="sidebar-user">
          <div className="sidebar-user-id" title={auth.user?.email ?? ""}>
            {auth.user?.displayName || auth.user?.email || "signed in"}
          </div>
          <button className="link-btn" onClick={() => auth.logout()}>
            Sign out
          </button>
        </div>
      </aside>

      {!current && (
        <div className="screen-body">
          <p className="muted">
            Your account has no access yet. Ask an administrator to grant you a
            role.
          </p>
        </div>
      )}
      {current === "pipelines" && (
        <PipelinesScreen onEditPipeline={openInBuilder} />
      )}
      {current === "builder" && (
        <PipelineBuilder
          editing={editing}
          onClearEditing={() => setEditing(undefined)}
        />
      )}
      {current === "scheduler" && <SchedulerScreen />}
      {current === "tenants" && <TenantsScreen />}
      {current === "config" && <ConfigScreen />}
      {current === "secrets" && <SecretsScreen />}
      {current === "executions" && <ExecutionsScreen />}
      {current === "audit" && <AuditScreen />}
      {current === "usage" && <UsageScreen />}
      {current === "users" && <UsersScreen />}
      {current === "roles" && <RolesScreen />}
      {current === "identity-providers" && <IdentityProvidersScreen />}
      {current === "auth-settings" && <AuthSettingsScreen />}
    </main>
  );
}

function Gate() {
  const auth = useAuth();
  if (auth.status === "loading") {
    return (
      <div className="login-shell">
        <div className="muted">Loading…</div>
      </div>
    );
  }
  if (auth.status === "anonymous") return <LoginScreen />;
  return <Shell />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </QueryClientProvider>
  );
}
