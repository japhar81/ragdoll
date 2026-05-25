import React, { useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  BrowserRouter,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams
} from "react-router-dom";
import { TooltipProvider, Tooltip } from "./components/help/Tooltip.tsx";
import { CommandPalette } from "./components/help/CommandPalette.tsx";
import { ShortcutsOverlay } from "./components/help/ShortcutsOverlay.tsx";
import { HelpDrawer } from "./components/help/HelpDrawer.tsx";
import { useGlobalHelpKeys } from "./components/help/useGlobalHelpKeys.ts";
import { routeToDoc, type HelpDocSlug } from "./lib/help.ts";
import { PipelineBuilder } from "./components/PipelineBuilder.tsx";
import { PipelinesScreen } from "./components/PipelinesScreen.tsx";
import { DatasetsScreen } from "./components/DatasetsScreen.tsx";
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
import { ProfileScreen } from "./components/ProfileScreen.tsx";
import { LoginScreen } from "./components/LoginScreen.tsx";
import { AuthProvider, useAuth } from "./auth/AuthContext.tsx";
import { EventsProvider, useEvents, statusLabel } from "./events/EventsProvider.tsx";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } }
});

/** A view's URL path; kept here so adding a route is one edit. */
type NavItem = {
  /** Path under the SPA, e.g. `/users`. */
  path: string;
  label: string;
  /** Sidebar visibility (any-of). Empty = visible to any authenticated user. */
  perms: string[];
};

const NAV_GROUPS: Array<{ group: string; items: NavItem[] }> = [
  {
    group: "Build",
    items: [
      {
        path: "/pipelines",
        label: "Pipelines",
        perms: ["execution:view_logs", "pipeline:create", "pipeline:update"]
      },
      {
        path: "/datasets",
        label: "Datasets",
        perms: ["dataset:read"]
      },
      {
        path: "/builder",
        label: "Builder",
        perms: ["pipeline:create", "pipeline:update"]
      },
      {
        path: "/scheduler",
        label: "Scheduler",
        perms: ["pipeline:run", "config:edit_tenant"]
      }
    ]
  },
  {
    group: "Operate",
    items: [
      { path: "/executions", label: "Executions", perms: ["execution:view_logs"] },
      { path: "/usage", label: "Usage", perms: ["execution:view_logs"] },
      { path: "/audit", label: "Audit", perms: ["audit:view"] }
    ]
  },
  {
    group: "Govern",
    items: [
      { path: "/tenants", label: "Tenants", perms: ["config:edit_global"] },
      {
        path: "/config",
        label: "Config",
        perms: ["config:edit_global", "config:edit_tenant", "config:edit_pipeline"]
      },
      { path: "/secrets", label: "Secrets", perms: ["secret:manage_tenant"] }
    ]
  },
  {
    group: "Access",
    items: [
      { path: "/users", label: "Users", perms: ["user:manage"] },
      { path: "/roles", label: "Roles & Permissions", perms: ["role:manage"] },
      {
        path: "/identity-providers",
        label: "Identity Providers",
        perms: ["idp:manage"]
      },
      { path: "/auth-settings", label: "Auth Settings", perms: ["auth:settings"] }
    ]
  }
];

export interface EditingPipeline {
  id: string;
  name: string;
}

/**
 * URL-driven Builder mount: `/builder` (blank canvas) and `/builder/:pipelineId`
 * (load that pipeline). Memoising `editing` on the id keeps the Builder's
 * `loadedFor` guard happy across re-renders. `onClearEditing` navigates back
 * to the blank Builder URL, so a back-button press lands where you expect.
 */
function BuilderRoute() {
  const { pipelineId } = useParams<{ pipelineId: string }>();
  const navigate = useNavigate();
  const editing = useMemo<EditingPipeline | undefined>(
    () => (pipelineId ? { id: pipelineId, name: "" } : undefined),
    [pipelineId]
  );
  return (
    <PipelineBuilder
      editing={editing}
      onClearEditing={() => navigate("/builder")}
    />
  );
}

/**
 * URL-driven Pipelines list: clicking "Edit" navigates to the Builder route
 * for that pipeline so the back button returns to this list.
 */
function PipelinesRoute() {
  const navigate = useNavigate();
  return (
    <PipelinesScreen
      onEditPipeline={(p) =>
        navigate(`/builder/${encodeURIComponent(p.id)}`)
      }
    />
  );
}

function Shell() {
  const auth = useAuth();
  const navigate = useNavigate();
  const loc = useLocation();

  // Only show nav items the user can act on. The server still enforces; this
  // is just cosmetic. Used both for sidebar rendering and to pick the default
  // landing route for `/`.
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

  const defaultPath = groups[0]?.items[0]?.path ?? null;

  // ---- embedded help wiring -------------------------------------------
  // Help drawer state: opened by the sidebar button or via a Cmd-K
  // "Docs · …" entry. We pre-tune `helpSlug` to the current route's most
  // relevant doc; the drawer's left nav still lets the user navigate freely.
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpSlug, setHelpSlug] = useState<HelpDocSlug | null>(null);
  const keys = useGlobalHelpKeys({
    onGoTo: (target) => navigate(`/${target}`)
  });
  function openHelp(slug?: HelpDocSlug | null) {
    setHelpSlug(slug ?? routeToDoc(loc.pathname));
    setHelpOpen(true);
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
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={({ isActive }) => (isActive ? "active" : undefined)}
                  end={item.path === "/pipelines"}
                >
                  {item.label}
                </NavLink>
              ))}
            </React.Fragment>
          ))}
        </nav>
        <div className="sidebar-help">
          <Tooltip label="Search commands &amp; docs (⌘K)" side="right">
            <button
              type="button"
              className="sidebar-cmdk-btn"
              onClick={() => keys.setPaletteOpen(true)}
            >
              <span>Search</span>
              <kbd>⌘K</kbd>
            </button>
          </Tooltip>
          <Tooltip label="Open the docs for this page" side="right">
            <button
              type="button"
              className="link-btn"
              onClick={() => openHelp()}
            >
              Help
            </button>
          </Tooltip>
        </div>
        <div className="sidebar-user">
          <NavLink
            to="/profile"
            className={({ isActive }) =>
              isActive ? "sidebar-user-id active" : "sidebar-user-id"
            }
            title="Open your profile"
          >
            {auth.user?.displayName || auth.user?.email || "signed in"}
          </NavLink>
          <div className="sidebar-user-actions">
            <LiveStatusBadge />
            <button className="link-btn" onClick={() => auth.logout()}>
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <Routes>
        <Route
          path="/"
          element={
            defaultPath ? (
              <Navigate to={defaultPath} replace />
            ) : (
              <div className="screen-body">
                <p className="muted">
                  Your account has no access yet. Ask an administrator to grant
                  you a role.
                </p>
              </div>
            )
          }
        />
        <Route path="/pipelines" element={<PipelinesRoute />} />
        <Route path="/datasets" element={<DatasetsScreen />} />
        <Route path="/datasets/:datasetId" element={<DatasetsScreen />} />
        <Route path="/builder" element={<BuilderRoute />} />
        <Route path="/builder/:pipelineId" element={<BuilderRoute />} />
        <Route path="/scheduler" element={<SchedulerScreen />} />
        <Route path="/tenants" element={<TenantsScreen />} />
        <Route path="/config" element={<ConfigScreen />} />
        <Route path="/secrets" element={<SecretsScreen />} />
        <Route path="/executions" element={<ExecutionsScreen />} />
        <Route path="/audit" element={<AuditScreen />} />
        <Route path="/usage" element={<UsageScreen />} />
        <Route path="/users" element={<UsersScreen />} />
        <Route path="/roles" element={<RolesScreen />} />
        <Route
          path="/identity-providers"
          element={<IdentityProvidersScreen />}
        />
        <Route path="/auth-settings" element={<AuthSettingsScreen />} />
        {/* Self-service: reachable by any signed-in user (no nav perm). */}
        <Route path="/profile" element={<ProfileScreen />} />
        {/* Unknown routes: fall back to whichever view the user can see, so a
            stale bookmark or a typo doesn't 404 the SPA. */}
        <Route
          path="*"
          element={
            defaultPath ? <Navigate to={defaultPath} replace /> : null
          }
        />
      </Routes>

      <CommandPalette
        open={keys.paletteOpen}
        onOpenChange={keys.setPaletteOpen}
        can={auth.can}
        onRun={(action) => {
          if (action.kind.type === "navigate") {
            navigate(action.kind.to);
          } else if (action.kind.type === "openDoc") {
            openHelp(action.kind.doc);
          } else if (action.kind.type === "openShortcuts") {
            keys.setShortcutsOpen(true);
          }
        }}
      />
      <ShortcutsOverlay
        open={keys.shortcutsOpen}
        onOpenChange={keys.setShortcutsOpen}
      />
      <HelpDrawer open={helpOpen} onOpenChange={setHelpOpen} slug={helpSlug} />
    </main>
  );
}

/**
 * Auth gate. While anonymous we render the login screen at WHATEVER URL the
 * user is on — refreshing or deep-linking to `/users` while logged out shows
 * the login screen there, and after sign-in the Shell renders that exact URL.
 */
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
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthProvider>
            <EventsProvider>
              <Gate />
            </EventsProvider>
          </AuthProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </BrowserRouter>
  );
}

/** Compact connection-status pill rendered in the sidebar. */
function LiveStatusBadge() {
  const events = useEvents();
  return (
    <span
      className={`live-badge live-badge-${events.status}`}
      title={`Live updates: ${statusLabel(events.status)}`}
      aria-label={`Live updates ${statusLabel(events.status)}`}
    >
      <span className="live-dot" />
      {statusLabel(events.status)}
    </span>
  );
}
