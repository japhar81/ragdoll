import React, { useEffect, useMemo, useState } from "react";
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

/** A view's URL path; kept here so adding a route is one edit. */
type NavItem = {
  /** Path under the SPA, e.g. `/users`. */
  path: string;
  label: string;
  /** Bootstrap-Icons class name (e.g. "bi-diagram-3"). */
  icon: string;
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
        icon: "bi-diagram-3",
        perms: ["execution:view_logs", "pipeline:create", "pipeline:update"]
      },
      {
        path: "/builder",
        label: "Builder",
        icon: "bi-grid-3x3-gap",
        perms: ["pipeline:create", "pipeline:update"]
      },
      {
        path: "/scheduler",
        label: "Scheduler",
        icon: "bi-clock-history",
        perms: ["pipeline:run", "config:edit_tenant"]
      }
    ]
  },
  {
    group: "Operate",
    items: [
      { path: "/executions", label: "Executions", icon: "bi-play-circle", perms: ["execution:view_logs"] },
      { path: "/usage", label: "Usage", icon: "bi-graph-up", perms: ["execution:view_logs"] },
      { path: "/audit", label: "Audit", icon: "bi-journal-text", perms: ["audit:view"] }
    ]
  },
  {
    group: "Govern",
    items: [
      { path: "/tenants", label: "Tenants", icon: "bi-building", perms: ["config:edit_global"] },
      {
        path: "/config",
        label: "Config",
        icon: "bi-sliders",
        perms: ["config:edit_global", "config:edit_tenant", "config:edit_pipeline"]
      },
      { path: "/secrets", label: "Secrets", icon: "bi-key", perms: ["secret:manage_tenant"] }
    ]
  },
  {
    group: "Access",
    items: [
      { path: "/users", label: "Users", icon: "bi-people", perms: ["user:manage"] },
      { path: "/roles", label: "Roles & Permissions", icon: "bi-shield-lock", perms: ["role:manage"] },
      {
        path: "/identity-providers",
        label: "Identity Providers",
        icon: "bi-fingerprint",
        perms: ["idp:manage"]
      },
      { path: "/auth-settings", label: "Auth Settings", icon: "bi-gear", perms: ["auth:settings"] }
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
 * `loadedFor` guard happy across re-renders.
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

/** Persisted dark-mode toggle (Bootstrap 5.3's `data-bs-theme` attribute). */
function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof localStorage === "undefined") return "light";
    const stored = localStorage.getItem("ragdoll.theme");
    if (stored === "dark" || stored === "light") return stored;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-bs-theme", theme);
    try {
      localStorage.setItem("ragdoll.theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return {
    theme,
    toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark"))
  };
}

function Shell() {
  const auth = useAuth();
  const navigate = useNavigate();
  const loc = useLocation();
  const { theme, toggle } = useTheme();

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

  const [helpOpen, setHelpOpen] = useState(false);
  const [helpSlug, setHelpSlug] = useState<HelpDocSlug | null>(null);
  const keys = useGlobalHelpKeys({
    onGoTo: (target) => navigate(`/${target}`)
  });
  function openHelp(slug?: HelpDocSlug | null) {
    setHelpSlug(slug ?? routeToDoc(loc.pathname));
    setHelpOpen(true);
  }

  // The Builder owns its full canvas, so its route shouldn't get the standard
  // page padding from .admin-main.with-pad.
  const isBuilder = loc.pathname.startsWith("/builder");
  const mainClass = isBuilder ? "admin-main no-pad" : "admin-main with-pad";

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <a
          href="#/"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            if (defaultPath) navigate(defaultPath);
          }}
        >
          <span className="brand-mark">
            <i className="bi bi-stars" />
          </span>
          RAGdoll
        </a>

        <span className="header-spacer" />

        <Tooltip label="Search commands & docs (⌘K)">
          <button
            type="button"
            className="header-search"
            onClick={() => keys.setPaletteOpen(true)}
          >
            <i className="bi bi-search" /> Search
            <kbd>⌘K</kbd>
          </button>
        </Tooltip>

        <Tooltip label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}>
          <button
            type="button"
            className="header-action"
            aria-label="Toggle theme"
            onClick={toggle}
          >
            <i className={theme === "dark" ? "bi bi-sun" : "bi bi-moon"} />
          </button>
        </Tooltip>

        <Tooltip label="Open docs for this page">
          <button
            type="button"
            className="header-action"
            aria-label="Help"
            onClick={() => openHelp()}
          >
            <i className="bi bi-question-circle" />
          </button>
        </Tooltip>

        <div className="dropdown">
          <button
            className="header-action"
            type="button"
            data-bs-toggle="dropdown"
            aria-expanded="false"
            aria-label="Account"
            title={auth.user?.email ?? ""}
          >
            <i className="bi bi-person-circle" />
          </button>
          <ul className="dropdown-menu dropdown-menu-end">
            <li>
              <span className="dropdown-item-text small text-muted">
                {auth.user?.displayName || auth.user?.email || "signed in"}
              </span>
            </li>
            <li><hr className="dropdown-divider" /></li>
            <li>
              <button
                className="dropdown-item"
                type="button"
                onClick={() => auth.logout()}
              >
                <i className="bi bi-box-arrow-right me-2" /> Sign out
              </button>
            </li>
          </ul>
        </div>
      </header>

      <aside className="admin-sidebar">
        <nav className="sidebar-nav">
          {groups.map((g, gi) => (
            <React.Fragment key={g.group}>
              <span className={"sidebar-section" + (gi === 0 ? " first" : "")}>
                {g.group}
              </span>
              {g.items.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={({ isActive }) =>
                    "nav-link" + (isActive ? " active" : "")
                  }
                  end={item.path === "/pipelines"}
                >
                  <i className={`bi ${item.icon}`} aria-hidden="true" />
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </React.Fragment>
          ))}
        </nav>
      </aside>

      <main className={mainClass}>
        <Routes>
          <Route
            path="/"
            element={
              defaultPath ? (
                <Navigate to={defaultPath} replace />
              ) : (
                <div className="empty-state">
                  <div className="empty-state-icon">
                    <i className="bi bi-shield-exclamation" />
                  </div>
                  <div className="empty-state-title">No access yet</div>
                  <div className="empty-state-body">
                    Your account has no role grants. Ask an administrator to
                    grant you a role.
                  </div>
                </div>
              )
            }
          />
          <Route path="/pipelines" element={<PipelinesRoute />} />
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
          <Route
            path="*"
            element={
              defaultPath ? <Navigate to={defaultPath} replace /> : null
            }
          />
        </Routes>
      </main>

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
    </div>
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
            <Gate />
          </AuthProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </BrowserRouter>
  );
}
