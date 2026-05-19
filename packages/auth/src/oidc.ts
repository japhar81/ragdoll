/**
 * Minimal, dependency-free OpenID Connect (authorization-code flow) client.
 *
 * The codebase deliberately avoids runtime deps and hand-rolls its crypto
 * (HMAC session tokens, sha256 API keys); a stock OIDC code flow is small
 * enough to do the same with `fetch` + `node:crypto` JWKS verification, which
 * keeps it install-free, audit-friendly, and free of a fragile transitive dep.
 *
 * Validates: issuer, audience, expiry, and the `nonce` bound to the login.
 * ID-token signatures are checked with RS256 against the provider JWKS.
 */
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";

export interface OidcConfig {
  /** Issuer URL; `<issuer>/.well-known/openid-configuration` is discovered. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Defaults to "openid email profile". */
  scopes?: string;
}

export interface SsoIdentity {
  subject: string;
  email?: string;
  name?: string;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

export class OidcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcError";
  }
}

function b64urlJson(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/** A short random value for `state` / `nonce`. */
export function randomToken(): string {
  return randomBytes(24).toString("base64url");
}

export class OidcProvider {
  private config: OidcConfig;
  private discovery?: Discovery;
  private jwks?: { keys: Array<Record<string, unknown>> };

  constructor(config: OidcConfig) {
    this.config = config;
  }

  private async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const url =
      this.config.issuer.replace(/\/$/, "") +
      "/.well-known/openid-configuration";
    const res = await fetch(url);
    if (!res.ok) {
      throw new OidcError(`OIDC discovery failed (${res.status}) for ${url}`);
    }
    this.discovery = (await res.json()) as Discovery;
    return this.discovery;
  }

  async authorizationUrl(args: {
    redirectUri: string;
    state: string;
    nonce: string;
  }): Promise<string> {
    const d = await this.discover();
    const u = new URL(d.authorization_endpoint);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", this.config.clientId);
    u.searchParams.set("redirect_uri", args.redirectUri);
    u.searchParams.set("scope", this.config.scopes ?? "openid email profile");
    u.searchParams.set("state", args.state);
    u.searchParams.set("nonce", args.nonce);
    return u.toString();
  }

  private async verifyIdToken(
    idToken: string,
    expectedNonce: string
  ): Promise<SsoIdentity> {
    const [h, p, s] = idToken.split(".");
    if (!h || !p || !s) throw new OidcError("Malformed id_token");
    const header = b64urlJson(h);
    const claims = b64urlJson(p);
    const d = await this.discover();

    if (!this.jwks) {
      const res = await fetch(d.jwks_uri);
      if (!res.ok) throw new OidcError("Unable to fetch JWKS");
      this.jwks = (await res.json()) as { keys: Array<Record<string, unknown>> };
    }
    const jwk = this.jwks.keys.find((k) => k.kid === header.kid) ??
      this.jwks.keys[0];
    if (!jwk) throw new OidcError("No JWKS key");

    const key = createPublicKey({ key: jwk as never, format: "jwk" });
    const ok = verify(
      "RSA-SHA256",
      Buffer.from(`${h}.${p}`),
      key,
      Buffer.from(s, "base64url")
    );
    if (!ok) throw new OidcError("id_token signature invalid");

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp === "number" && now >= claims.exp) {
      throw new OidcError("id_token expired");
    }
    const iss = String(claims.iss ?? "");
    if (iss.replace(/\/$/, "") !== d.issuer.replace(/\/$/, "")) {
      throw new OidcError("id_token issuer mismatch");
    }
    const aud = claims.aud;
    const audOk = Array.isArray(aud)
      ? aud.includes(this.config.clientId)
      : aud === this.config.clientId;
    if (!audOk) throw new OidcError("id_token audience mismatch");
    if (claims.nonce !== expectedNonce) {
      throw new OidcError("id_token nonce mismatch");
    }
    if (!claims.sub) throw new OidcError("id_token has no subject");

    return {
      subject: String(claims.sub),
      email: typeof claims.email === "string" ? claims.email : undefined,
      name:
        typeof claims.name === "string"
          ? claims.name
          : typeof claims.preferred_username === "string"
            ? claims.preferred_username
            : undefined
    };
  }

  async handleCallback(args: {
    code: string;
    redirectUri: string;
    expectedNonce: string;
  }): Promise<SsoIdentity> {
    const d = await this.discover();
    const basic = Buffer.from(
      `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(
        this.config.clientSecret
      )}`
    ).toString("base64");
    const res = await fetch(d.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basic}`
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: args.code,
        redirect_uri: args.redirectUri
      }).toString()
    });
    if (!res.ok) {
      throw new OidcError(`Token exchange failed (${res.status})`);
    }
    const tokens = (await res.json()) as { id_token?: string };
    if (!tokens.id_token) throw new OidcError("No id_token in token response");
    return this.verifyIdToken(tokens.id_token, args.expectedNonce);
  }
}

/** Stable hash of a provider config, used to invalidate cached discovery. */
export function configFingerprint(config: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(config))
    .digest("hex")
    .slice(0, 16);
}
