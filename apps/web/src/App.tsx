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
import { ConnectionsScreen } from "./components/ConnectionsScreen.tsx";
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
import { RetentionScreen } from "./components/RetentionScreen.tsx";
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
  /** Single glyph rendered before the label. Inline SVGs keep us free of
   *  an icon dependency; one per nav row is small enough. */
  icon?: string;
};

/** Outline-style 18×18 SVG paths, sized to match the sidebar's 13px text
 *  baseline. Picked from Lucide / Tabler conventions — square route,
 *  pure functional, no extra dependency. */
const NAV_ICONS: Record<string, string> = {
  pipelines:
    "M5 4h14M5 12h14M5 20h14 M9 8h6 M9 16h6", // 3 horizontal bars + 2 short = "stacked stages"
  datasets:
    "M4 6c0-1.1 3.6-2 8-2s8 .9 8 2-3.6 2-8 2-8-.9-8-2zm0 0v6c0 1.1 3.6 2 8 2s8-.9 8-2V6 M4 12v6c0 1.1 3.6 2 8 2s8-.9 8-2v-6", // cylinder
  builder: "M5 3v18 M19 3v18 M5 8h14 M5 16h14", // brackets
  scheduler:
    "M12 7v5l3 3 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z", // clock
  executions: "M5 4l14 8-14 8V4z", // play
  usage:
    "M3 20h18 M7 16V8 M12 16V4 M17 16V11", // bars
  audit:
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h4", // document
  tenants:
    "M3 21V8l9-5 9 5v13 M9 21v-7h6v7 M3 9h18", // building
  config: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.5-2.5.6a7 7 0 0 0-2.1-1.2L13.5 3h-3l-.8 2.2a7 7 0 0 0-2.1 1.2L5.1 5.8l-2 3.5L5.1 11a7 7 0 0 0 0 2L3.1 14.5l2 3.5 2.5-.6a7 7 0 0 0 2.1 1.2l.8 2.2h3l.8-2.2a7 7 0 0 0 2.1-1.2l2.5.6 2-3.5L18.9 13 19 12z",
  secrets: "M6 11V8a6 6 0 0 1 12 0v3 M5 11h14v10H5z M12 16v2",
  connections:
    "M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1 M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1", // two interlocked chain links
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M22 21v-2a4 4 0 0 0-3-3.9 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M16 3.1a4 4 0 0 1 0 7.8",
  roles: "M12 1l3 6 6 .9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 7.9 9 7z",
  "identity-providers":
    "M9 12l2 2 4-4 M12 22s-8-4-8-12V4l8-2 8 2v6c0 8-8 12-8 12z",
  "auth-settings":
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z M12 8v4l3 2",
  retention:
    "M3 6h18 M8 6v14a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V6 M10 11v6 M14 11v6 M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"
};

function iconKeyFor(path: string): string | undefined {
  // /pipelines → "pipelines", /identity-providers → "identity-providers"
  const m = path.match(/^\/([^/]+)/);
  return m ? m[1] : undefined;
}

function NavIcon({ path }: { path: string }) {
  const key = iconKeyFor(path);
  const d = key ? NAV_ICONS[key] : undefined;
  if (!d) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="nav-icon"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

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
      { path: "/secrets", label: "Secrets", perms: ["secret:manage_tenant"] },
      // Per-(tenant, env) backing-store host + creds registry. Datasets
      // reference these by name; plugins resolve them through the dataset
      // and never see the host directly.
      { path: "/connections", label: "Connections", perms: ["dataset:read"] }
    ]
  },
  {
    group: "Settings",
    items: [
      { path: "/users", label: "Users", perms: ["user:manage"] },
      { path: "/roles", label: "Roles & Permissions", perms: ["role:manage"] },
      {
        path: "/identity-providers",
        label: "Identity Providers",
        perms: ["idp:manage"]
      },
      { path: "/auth-settings", label: "Auth Settings", perms: ["auth:settings"] },
      {
        path: "/retention",
        label: "Retention",
        perms: ["config:edit_global"]
      }
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
                  className={({ isActive }) =>
                    `nav-link${isActive ? " active" : ""}`
                  }
                  end={item.path === "/pipelines"}
                >
                  <NavIcon path={item.path} />
                  <span>{item.label}</span>
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
        <Route path="/connections" element={<ConnectionsScreen />} />
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
        <Route path="/retention" element={<RetentionScreen />} />
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
