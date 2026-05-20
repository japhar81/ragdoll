import React, { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api.ts";
import { useAuth } from "../auth/AuthContext.tsx";

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body as { error?: string; message?: string } | undefined;
    if (b?.error === "invalid_credentials") return "Incorrect email or password.";
    if (b?.error === "account_disabled") return "This account is disabled.";
    if (b?.error === "signup_disabled")
      return "Self-service signup is disabled. Ask an administrator for an account.";
    if (b?.error === "email_in_use") return "An account with that email already exists.";
    if (b?.error === "weak_password") return "Password must be at least 8 characters.";
    return b?.message ?? b?.error ?? `Request failed (HTTP ${e.status}).`;
  }
  return e instanceof Error ? e.message : "Request failed.";
}

export function LoginScreen() {
  const auth = useAuth();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [providers, setProviders] = useState<
    Array<{ slug: string; kind: string; displayName: string }>
  >([]);

  useEffect(() => {
    api
      .authProviders()
      .then((r) => setProviders(r.providers))
      .catch(() => setProviders([]));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (mode === "login") {
        await auth.login(email.trim(), password);
      } else {
        await auth.signup({
          email: email.trim(),
          password,
          displayName: displayName.trim() || undefined
        });
      }
    } catch (e2) {
      setErr(errText(e2));
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-brand">
          <span className="login-logo">
            <i className="bi bi-stars" />
          </span>
          <h1>RAGdoll</h1>
        </div>
        <p className="login-sub">
          {mode === "login" ? "Sign in to the control plane" : "Create an account"}
        </p>

        <form className="login-form" onSubmit={submit}>
          <label>
            Email
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          {mode === "signup" && (
            <label>
              Display name <span className="login-opt">(optional)</span>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </label>
          )}
          <label>
            Password
            <input
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>

          {err && <div className="login-error">{err}</div>}

          <button type="submit" className="primary login-submit" disabled={busy}>
            {busy
              ? "Please wait…"
              : mode === "login"
                ? "Sign in"
                : "Create account"}
          </button>
        </form>

        {providers.length > 0 && (
          <>
            <div className="login-divider">
              <span>or continue with</span>
            </div>
            <div className="login-sso">
              {providers.map((p) => (
                <a
                  key={p.slug}
                  className="login-sso-btn"
                  href={api.ssoStartUrl(p.slug)}
                >
                  {p.displayName}
                  <span className="login-sso-kind">{p.kind.toUpperCase()}</span>
                </a>
              ))}
            </div>
          </>
        )}

        <div className="login-foot">
          {mode === "login" ? (
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setMode("signup");
                setErr(null);
              }}
            >
              Need an account? Sign up
            </button>
          ) : (
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setMode("login");
                setErr(null);
              }}
            >
              Already have an account? Sign in
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
