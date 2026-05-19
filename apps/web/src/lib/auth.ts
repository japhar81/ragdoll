/**
 * Pure, DOM-light session-token helpers. No React; storage is injected so the
 * decode/expiry/hash logic is unit-testable with `node --test`, zero install
 * (mirrors lib/tenantContext.ts).
 *
 * The control-plane issues a compact HMAC token `b64url(h).b64url(p).sig`.
 * The browser cannot verify the signature (that's the server's job) — it only
 * reads the unverified payload to show the user and pre-empt an expired token.
 */

const STORAGE_KEY = "ragdoll.session.token";

export interface TokenClaims {
  sub: string;
  type?: string;
  exp?: number;
  iat?: number;
}

/** Decode the (unverified) payload of a RAGdoll/JWT-style token. */
export function decodeToken(token: string | null | undefined): TokenClaims | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const claims = JSON.parse(json) as TokenClaims;
    return typeof claims.sub === "string" ? claims : null;
  } catch {
    return null;
  }
}

/** True when the token is missing, malformed, or past its `exp`. */
export function isExpired(token: string | null | undefined, nowMs = Date.now()): boolean {
  const claims = decodeToken(token);
  if (!claims) return true;
  if (typeof claims.exp !== "number") return false;
  return nowMs >= claims.exp * 1000;
}

/**
 * Extract `access_token` delivered by the SSO callback redirect in the URL
 * fragment (`/#access_token=...`). Returns the token or undefined.
 */
export function readTokenFromHash(hash: string | undefined): string | undefined {
  if (!hash) return undefined;
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(h);
  return params.get("access_token") ?? undefined;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storage(): StorageLike | undefined {
  try {
    return typeof localStorage !== "undefined" ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

export function loadToken(store: StorageLike | undefined = storage()): string | undefined {
  const t = store?.getItem(STORAGE_KEY) ?? undefined;
  return t && !isExpired(t) ? t : undefined;
}

export function saveToken(
  token: string,
  store: StorageLike | undefined = storage()
): void {
  store?.setItem(STORAGE_KEY, token);
}

export function clearToken(store: StorageLike | undefined = storage()): void {
  store?.removeItem(STORAGE_KEY);
}

/** Strip the SSO `#access_token=...` fragment from the address bar (no reload). */
export function stripAuthHash(): void {
  try {
    if (typeof history !== "undefined" && location.hash.includes("access_token")) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  } catch {
    /* non-browser: nothing to strip */
  }
}
