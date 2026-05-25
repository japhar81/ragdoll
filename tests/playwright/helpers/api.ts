/**
 * REST client used by globalSetup / teardown and the specs themselves for
 * the parts that aren't UI flows (tenant create / delete, scratch data
 * setup). Holds a Bearer session token minted by signing in as the
 * bootstrap admin.
 */
import { API_URL } from "./env.ts";

export interface RestClient {
  token: string;
  tenantId?: string;
  request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    init?: { tenantId?: string; expect?: number }
  ): Promise<T>;
}

export async function signIn(
  email: string,
  password: string
): Promise<{ token: string; principalId?: string }> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`sign-in failed: HTTP ${res.status} ${text}`);
  }
  const body = (await res.json()) as {
    token?: string;
    sessionToken?: string;
    user?: { id?: string };
  };
  const token = body.token ?? body.sessionToken;
  if (!token) throw new Error(`sign-in did not return a token: ${JSON.stringify(body)}`);
  return { token, principalId: body.user?.id };
}

export function createRestClient(token: string, tenantId?: string): RestClient {
  return {
    token,
    tenantId,
    async request<T = unknown>(
      method: string,
      path: string,
      body?: unknown,
      init: { tenantId?: string; expect?: number } = {}
    ): Promise<T> {
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`
      };
      // Only attach content-type when we're actually sending a JSON
      // body — Fastify 400s on an empty body when content-type is set
      // ("FST_ERR_CTP_EMPTY_JSON_BODY"), which is the failure mode the
      // DELETE wrappers hit when the helper was unconditionally adding
      // the header.
      if (body !== undefined) headers["content-type"] = "application/json";
      const effectiveTenant = init.tenantId ?? tenantId;
      if (effectiveTenant) headers["x-tenant-id"] = effectiveTenant;
      const res = await fetch(`${API_URL}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const expect = init.expect ?? -1;
      const text = await res.text();
      if (expect > 0 ? res.status !== expect : !res.ok) {
        throw new Error(
          `${method} ${path} returned HTTP ${res.status} (expected ${expect > 0 ? expect : "<2xx>"}): ${text}`
        );
      }
      if (text.length === 0) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as T;
      }
    }
  };
}
