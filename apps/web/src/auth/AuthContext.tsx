import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";
import { api, type AccountUser, type GrantView } from "../lib/api.ts";
import {
  clearToken,
  loadToken,
  readTokenFromHash,
  saveToken,
  stripAuthHash
} from "../lib/auth.ts";

type Status = "loading" | "authenticated" | "anonymous";

interface AuthState {
  status: Status;
  user: AccountUser | null;
  grants: GrantView[];
  permissions: Set<string>;
  /** Coarse, scope-agnostic check used only to show/hide UI. The server
   * still enforces the real scoped decision on every call. */
  can: (...perms: string[]) => boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (input: {
    email: string;
    password: string;
    displayName?: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | undefined>(undefined);

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}

export function AuthProvider(props: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<AccountUser | null>(null);
  const [grants, setGrants] = useState<GrantView[]>([]);
  const [permissions, setPermissions] = useState<Set<string>>(new Set());

  const applySession = useCallback(async (token: string) => {
    saveToken(token);
    api.setAuth({ ...api.getAuth(), token });
    const me = await api.me();
    setUser(me.user);
    setGrants(me.grants ?? []);
    setPermissions(new Set(me.permissions ?? []));
    setStatus("authenticated");
  }, []);

  const refresh = useCallback(async () => {
    try {
      const me = await api.me();
      setUser(me.user);
      setGrants(me.grants ?? []);
      setPermissions(new Set(me.permissions ?? []));
      setStatus("authenticated");
    } catch {
      clearToken();
      api.setAuth({ ...api.getAuth(), token: undefined });
      setStatus("anonymous");
    }
  }, []);

  useEffect(() => {
    // 1) SSO callback delivers the token in the URL fragment.
    const fromHash = readTokenFromHash(
      typeof location !== "undefined" ? location.hash : undefined
    );
    if (fromHash) {
      stripAuthHash();
      applySession(fromHash).catch(() => {
        clearToken();
        setStatus("anonymous");
      });
      return;
    }
    // 2) Otherwise resume a stored, unexpired session.
    const stored = loadToken();
    if (!stored) {
      setStatus("anonymous");
      return;
    }
    api.setAuth({ ...api.getAuth(), token: stored });
    refresh();
  }, [applySession, refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      const { token } = await api.login(email, password);
      await applySession(token);
    },
    [applySession]
  );

  const signup = useCallback(
    async (input: { email: string; password: string; displayName?: string }) => {
      const { token } = await api.signup(input);
      await applySession(token);
    },
    [applySession]
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* best-effort; token is discarded regardless */
    }
    clearToken();
    api.setAuth({ ...api.getAuth(), token: undefined });
    setUser(null);
    setGrants([]);
    setPermissions(new Set());
    setStatus("anonymous");
  }, []);

  const can = useCallback(
    (...perms: string[]) => perms.some((p) => permissions.has(p)),
    [permissions]
  );

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      grants,
      permissions,
      can,
      login,
      signup,
      logout,
      refresh
    }),
    [status, user, grants, permissions, can, login, signup, logout, refresh]
  );

  return <AuthCtx.Provider value={value}>{props.children}</AuthCtx.Provider>;
}
