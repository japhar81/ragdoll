import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  authorize,
  requirePermission,
  AuthorizationError,
  Authorizer,
  BuiltinPolicyEngine,
  type Permission,
  type Resource,
  type Role,
  type PolicyStore,
  type PolicyEngine
} from "../../authz/src/index.ts";

export type { Permission, Role, Resource, PolicyStore, PolicyEngine };
export { authorize, requirePermission, Authorizer, BuiltinPolicyEngine };
export { CasbinPolicyEngine, createCasbinEngine } from "../../authz/src/casbin.ts";

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

export type PrincipalType = "user" | "service" | "api_key";

export interface Principal {
  id: string;
  type: PrincipalType;
  tenantId?: string;
  roles: Role[];
  /**
   * Per-request synchronous decision closure, attached by the API after the
   * principal is resolved (see `Authorizer.authorizeClosure`). When present it
   * is the authoritative RBAC check (Casbin / scoped grants); when absent
   * `enforce` falls back to the legacy flat role->permission map so existing
   * callers and offline harnesses keep working unchanged.
   */
  authorize?: (permission: Permission, resource?: Resource) => boolean;
}

// ---------------------------------------------------------------------------
// Errors (mirrors the style of SecretAccessDeniedError in @ragdoll/secrets)
// ---------------------------------------------------------------------------

export class UnauthorizedError extends Error {
  constructor(message = "No usable credentials in request") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class InvalidCredentialsError extends Error {
  constructor(message = "Invalid credentials") {
    super(message);
    this.name = "InvalidCredentialsError";
  }
}

export class TokenInvalidError extends Error {
  constructor(message = "Session token is invalid") {
    super(message);
    this.name = "TokenInvalidError";
  }
}

export class TokenExpiredError extends Error {
  constructor() {
    super("Session token has expired");
    this.name = "TokenExpiredError";
  }
}

// ---------------------------------------------------------------------------
// Headers helper
// ---------------------------------------------------------------------------

export type Headers = Record<string, string | string[] | undefined>;

function headerValue(headers: Headers, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

function parseRoles(raw: string | undefined): Role[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((role) => role.trim())
    .filter((role) => role.length > 0) as Role[];
}

// ---------------------------------------------------------------------------
// DevAuthProvider
// ---------------------------------------------------------------------------

/**
 * DevAuthProvider resolves a {@link Principal} purely from request headers:
 *  - `x-actor-id`   -> principal id
 *  - `x-tenant-id`  -> tenant scope
 *  - `x-roles`      -> comma-separated list of roles
 *
 * SECURITY WARNING: This provider is INSECURE and intended ONLY for local
 * development. It performs no verification whatsoever — any caller can claim
 * any identity, tenant, or role simply by setting headers. It must NEVER be
 * enabled in a production deployment. Production environments must rely on the
 * session-token or API-key paths of {@link AuthResolver}.
 */
export class DevAuthProvider {
  private fallback: Principal;

  constructor(fallback?: Partial<Principal>) {
    this.fallback = {
      id: fallback?.id ?? "dev-user",
      type: fallback?.type ?? "user",
      tenantId: fallback?.tenantId,
      roles: fallback?.roles ?? (["platform_admin"] as Role[])
    };
  }

  resolve(headers: Headers): Principal {
    const id = headerValue(headers, "x-actor-id");
    const tenantId = headerValue(headers, "x-tenant-id");
    const roles = parseRoles(headerValue(headers, "x-roles"));

    if (!id) {
      return { ...this.fallback, roles: [...this.fallback.roles] };
    }

    return {
      id,
      type: "user",
      tenantId: tenantId ?? this.fallback.tenantId,
      roles: roles.length > 0 ? roles : [...this.fallback.roles]
    };
  }
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export interface ApiKeyRecord {
  id: string;
  prefix: string;
  hash: string;
  principalId: string;
  tenantId?: string;
  name: string;
  roles: Role[];
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface ApiKeyRepository {
  create(record: ApiKeyRecord): Promise<ApiKeyRecord>;
  findByPrefix(prefix: string): Promise<ApiKeyRecord | undefined>;
  touch(id: string): Promise<void>;
  revoke(id: string): Promise<void>;
}

export class InMemoryApiKeyRepository implements ApiKeyRepository {
  private records = new Map<string, ApiKeyRecord>();

  async create(record: ApiKeyRecord): Promise<ApiKeyRecord> {
    this.records.set(record.id, record);
    return record;
  }

  async findByPrefix(prefix: string): Promise<ApiKeyRecord | undefined> {
    for (const record of this.records.values()) {
      if (record.prefix === prefix) return record;
    }
    return undefined;
  }

  async touch(id: string): Promise<void> {
    const record = this.records.get(id);
    if (record) record.lastUsedAt = new Date().toISOString();
  }

  async revoke(id: string): Promise<void> {
    const record = this.records.get(id);
    if (record) record.revokedAt = new Date().toISOString();
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface IssueApiKeyInput {
  principalId: string;
  tenantId?: string;
  name: string;
  roles: Role[];
}

export interface IssuedApiKey {
  id: string;
  plaintext: string;
}

/**
 * Issues and verifies API keys. The plaintext key is `rgd_<prefix>_<secret>`
 * and is only ever returned once at issue time. Storage keeps a sha256 hash of
 * the full plaintext plus the lookup prefix; the secret itself is never
 * persisted.
 */
export class ApiKeyService {
  private repository: ApiKeyRepository;

  constructor(repository: ApiKeyRepository) {
    this.repository = repository;
  }

  async issue(input: IssueApiKeyInput): Promise<IssuedApiKey> {
    const id = randomBytes(16).toString("hex");
    const prefix = randomBytes(6).toString("hex");
    const secret = randomBytes(24).toString("hex");
    const plaintext = `rgd_${prefix}_${secret}`;

    await this.repository.create({
      id,
      prefix,
      hash: sha256Hex(plaintext),
      principalId: input.principalId,
      tenantId: input.tenantId,
      name: input.name,
      roles: input.roles,
      createdAt: new Date().toISOString()
    });

    return { id, plaintext };
  }

  async verify(rawKey: string): Promise<Principal> {
    const parts = rawKey.split("_");
    if (parts.length !== 3 || parts[0] !== "rgd" || !parts[1] || !parts[2]) {
      throw new InvalidCredentialsError("Malformed API key");
    }
    const prefix = parts[1];

    const record = await this.repository.findByPrefix(prefix);
    if (!record) throw new InvalidCredentialsError("Unknown API key");
    if (record.revokedAt) throw new InvalidCredentialsError("API key has been revoked");

    const candidate = Buffer.from(sha256Hex(rawKey), "hex");
    const expected = Buffer.from(record.hash, "hex");
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      throw new InvalidCredentialsError("API key signature mismatch");
    }

    await this.repository.touch(record.id);

    return {
      id: record.principalId,
      type: "api_key",
      tenantId: record.tenantId,
      roles: record.roles
    };
  }
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

interface SessionTokenPayload {
  sub: string;
  type: PrincipalType;
  tid?: string;
  roles: Role[];
  iat: number;
  exp: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Signs and verifies compact HMAC-SHA256 session tokens of the form
 * `base64url(header).base64url(payload).base64url(signature)`. Signature
 * verification uses a constant-time compare.
 */
export class SessionTokenService {
  private secret: string;

  constructor(secret: string) {
    if (!secret) throw new Error("SessionTokenService requires a non-empty secret");
    this.secret = secret;
  }

  private sign_(signingInput: string): string {
    return createHmac("sha256", this.secret).update(signingInput).digest("base64url");
  }

  sign(principal: Principal, ttlSeconds: number): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "HS256", typ: "RGD" };
    const payload: SessionTokenPayload = {
      sub: principal.id,
      type: principal.type,
      tid: principal.tenantId,
      roles: principal.roles,
      iat: now,
      exp: now + ttlSeconds
    };
    const encodedHeader = base64url(JSON.stringify(header));
    const encodedPayload = base64url(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    return `${signingInput}.${this.sign_(signingInput)}`;
  }

  verify(token: string): Principal {
    const segments = token.split(".");
    if (segments.length !== 3) throw new TokenInvalidError("Malformed token");
    const [encodedHeader, encodedPayload, signature] = segments;

    const expected = this.sign_(`${encodedHeader}.${encodedPayload}`);
    const provided = Buffer.from(signature);
    const expectedBuf = Buffer.from(expected);
    if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
      throw new TokenInvalidError("Signature mismatch");
    }

    let payload: SessionTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    } catch {
      throw new TokenInvalidError("Unparseable payload");
    }

    if (typeof payload.exp !== "number" || typeof payload.sub !== "string") {
      throw new TokenInvalidError("Invalid claims");
    }

    const now = Math.floor(Date.now() / 1000);
    if (now >= payload.exp) throw new TokenExpiredError();

    return {
      id: payload.sub,
      type: payload.type,
      tenantId: payload.tid,
      roles: payload.roles ?? []
    };
  }
}

// ---------------------------------------------------------------------------
// AuthResolver
// ---------------------------------------------------------------------------

/**
 * Framework-agnostic credential resolver. Resolution precedence:
 *   1. `Authorization: Bearer <session-token>`  -> SessionTokenService
 *   2. `Authorization: ApiKey <key>` or `x-api-key: <key>` -> ApiKeyService
 *   3. DevAuthProvider (insecure fallback for local dev)
 *
 * Takes a plain headers record so an API layer can wrap it (e.g. Fastify
 * preHandler) without coupling this package to a web framework.
 */
export class AuthResolver {
  private sessions?: SessionTokenService;
  private apiKeys?: ApiKeyService;
  private dev?: DevAuthProvider;

  constructor(options: {
    sessions?: SessionTokenService;
    apiKeys?: ApiKeyService;
    dev?: DevAuthProvider;
  }) {
    this.sessions = options.sessions;
    this.apiKeys = options.apiKeys;
    this.dev = options.dev;
  }

  async resolve(request: { headers: Headers }): Promise<Principal> {
    const headers = request.headers;
    const authorization = headerValue(headers, "authorization");

    if (authorization) {
      const [scheme, ...rest] = authorization.split(" ");
      const credential = rest.join(" ").trim();
      const lowerScheme = scheme.toLowerCase();

      if (lowerScheme === "bearer" && credential) {
        if (!this.sessions) throw new UnauthorizedError("Bearer token presented but no session service configured");
        return this.sessions.verify(credential);
      }

      if (lowerScheme === "apikey" && credential) {
        if (!this.apiKeys) throw new UnauthorizedError("API key presented but no API key service configured");
        return this.apiKeys.verify(credential);
      }
    }

    const apiKeyHeader = headerValue(headers, "x-api-key");
    if (apiKeyHeader) {
      if (!this.apiKeys) throw new UnauthorizedError("API key presented but no API key service configured");
      return this.apiKeys.verify(apiKeyHeader);
    }

    if (this.dev) {
      return this.dev.resolve(headers);
    }

    throw new UnauthorizedError();
  }
}

// ---------------------------------------------------------------------------
// RBAC bridge
// ---------------------------------------------------------------------------

/**
 * Authorize `principal` for `permission` on `resource`, throwing
 * {@link AuthorizationError} (mapped to HTTP 403 by the API) when denied.
 *
 * When the API has attached a scoped decision closure (`principal.authorize`),
 * that is authoritative: the resource's tenant/environment/pipeline define the
 * request scope and a grant must cover it (default-deny). Otherwise we fall
 * back to the legacy flat role map, merging the principal's own tenant into the
 * resource so cross-tenant access stays denied — this keeps offline harnesses
 * and any non-API caller behaving exactly as before.
 */
export function enforce(
  principal: Principal,
  permission: Permission,
  resource: Resource = {}
): void {
  if (principal.authorize) {
    if (!principal.authorize(permission, resource)) {
      throw new AuthorizationError(permission);
    }
    return;
  }
  requirePermission(
    { id: principal.id, tenantId: principal.tenantId, roles: principal.roles },
    permission,
    { ...resource, tenantId: resource.tenantId ?? principal.tenantId }
  );
}

// ---------------------------------------------------------------------------
// Local password, SSO, and account orchestration
// ---------------------------------------------------------------------------

export * from "./password.ts";
export * from "./oidc.ts";
export * from "./saml.ts";
export * from "./accounts.ts";
export * from "./webhookTokens.ts";
