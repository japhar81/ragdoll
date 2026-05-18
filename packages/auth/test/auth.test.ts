import test from "node:test";
import assert from "node:assert/strict";
import { AuthorizationError } from "../../authz/src/index.ts";
import {
  ApiKeyService,
  AuthResolver,
  DevAuthProvider,
  InMemoryApiKeyRepository,
  InvalidCredentialsError,
  SessionTokenService,
  TokenExpiredError,
  TokenInvalidError,
  UnauthorizedError,
  enforce,
  type Principal
} from "../src/index.ts";

// --- API keys --------------------------------------------------------------

test("api key issue/verify happy path", async () => {
  const repo = new InMemoryApiKeyRepository();
  const service = new ApiKeyService(repo);
  const { id, plaintext } = await service.issue({
    principalId: "svc-1",
    tenantId: "tenant-a",
    name: "ci",
    roles: ["pipeline_editor"]
  });
  assert.match(plaintext, /^rgd_[0-9a-f]+_[0-9a-f]+$/);

  const principal = await service.verify(plaintext);
  assert.equal(principal.id, "svc-1");
  assert.equal(principal.type, "api_key");
  assert.equal(principal.tenantId, "tenant-a");
  assert.deepEqual(principal.roles, ["pipeline_editor"]);

  const record = await repo.findByPrefix(plaintext.split("_")[1]);
  assert.equal(record?.id, id);
  assert.ok(record?.lastUsedAt, "verify should touch last-used");
});

test("api key wrong key is rejected", async () => {
  const service = new ApiKeyService(new InMemoryApiKeyRepository());
  const { plaintext } = await service.issue({ principalId: "svc-1", name: "ci", roles: [] });
  const prefix = plaintext.split("_")[1];
  await assert.rejects(service.verify(`rgd_${prefix}_deadbeef`), InvalidCredentialsError);
  await assert.rejects(service.verify("not-a-key"), InvalidCredentialsError);
  await assert.rejects(service.verify("rgd_unknownprefix_secret"), InvalidCredentialsError);
});

test("api key revoked key is rejected", async () => {
  const repo = new InMemoryApiKeyRepository();
  const service = new ApiKeyService(repo);
  const { id, plaintext } = await service.issue({ principalId: "svc-1", name: "ci", roles: [] });
  await service.verify(plaintext);
  await repo.revoke(id);
  await assert.rejects(service.verify(plaintext), InvalidCredentialsError);
});

test("api key prefix lookup", async () => {
  const repo = new InMemoryApiKeyRepository();
  const service = new ApiKeyService(repo);
  const { id, plaintext } = await service.issue({ principalId: "svc-2", name: "k", roles: ["viewer"] });
  const prefix = plaintext.split("_")[1];
  const found = await repo.findByPrefix(prefix);
  assert.equal(found?.id, id);
  assert.equal(found?.hash.length, 64);
  assert.notEqual(found?.hash, plaintext);
  assert.equal(await repo.findByPrefix("nope"), undefined);
});

// --- Session tokens --------------------------------------------------------

test("session token sign/verify round trip", () => {
  const svc = new SessionTokenService("dev-secret");
  const principal: Principal = { id: "u1", type: "user", tenantId: "t1", roles: ["viewer"] };
  const token = svc.sign(principal, 60);
  assert.equal(token.split(".").length, 3);
  const back = svc.verify(token);
  assert.deepEqual(back, principal);
});

test("session token expired is rejected", () => {
  const svc = new SessionTokenService("dev-secret");
  const token = svc.sign({ id: "u1", type: "user", roles: [] }, -1);
  assert.throws(() => svc.verify(token), TokenExpiredError);
});

test("session token tampered signature is rejected (constant-time path)", () => {
  const svc = new SessionTokenService("dev-secret");
  const token = svc.sign({ id: "u1", type: "user", roles: ["viewer"] }, 60);
  const [h, p] = token.split(".");
  const forged = `${h}.${p}.${"A".repeat(token.split(".")[2].length)}`;
  assert.throws(() => svc.verify(forged), TokenInvalidError);
  // Different secret -> signature mismatch.
  const other = new SessionTokenService("other-secret");
  assert.throws(() => other.verify(token), TokenInvalidError);
  // Malformed token.
  assert.throws(() => svc.verify("a.b"), TokenInvalidError);
});

// --- DevAuthProvider -------------------------------------------------------

test("dev provider parses headers", () => {
  const dev = new DevAuthProvider();
  const principal = dev.resolve({
    "x-actor-id": "alice",
    "x-tenant-id": "tenant-a",
    "x-roles": "viewer, pipeline_editor"
  });
  assert.equal(principal.id, "alice");
  assert.equal(principal.tenantId, "tenant-a");
  assert.deepEqual(principal.roles, ["viewer", "pipeline_editor"]);
});

test("dev provider falls back to default principal", () => {
  const dev = new DevAuthProvider({ id: "default-bot", roles: ["auditor"] });
  const principal = dev.resolve({});
  assert.equal(principal.id, "default-bot");
  assert.deepEqual(principal.roles, ["auditor"]);
});

// --- AuthResolver precedence ----------------------------------------------

test("resolver precedence: bearer over apikey over dev", async () => {
  const sessions = new SessionTokenService("s3cr3t");
  const repo = new InMemoryApiKeyRepository();
  const apiKeys = new ApiKeyService(repo);
  const dev = new DevAuthProvider({ id: "dev-fallback", roles: ["viewer"] });
  const resolver = new AuthResolver({ sessions, apiKeys, dev });

  const token = sessions.sign({ id: "session-user", type: "user", tenantId: "t1", roles: ["tenant_admin"] }, 60);
  const { plaintext } = await apiKeys.issue({ principalId: "key-user", name: "k", roles: ["viewer"] });

  // Bearer wins even when an API key header is also present.
  const viaBearer = await resolver.resolve({
    headers: { authorization: `Bearer ${token}`, "x-api-key": plaintext }
  });
  assert.equal(viaBearer.id, "session-user");

  // ApiKey scheme.
  const viaApiKeyScheme = await resolver.resolve({
    headers: { authorization: `ApiKey ${plaintext}` }
  });
  assert.equal(viaApiKeyScheme.id, "key-user");
  assert.equal(viaApiKeyScheme.type, "api_key");

  // x-api-key header.
  const viaApiKeyHeader = await resolver.resolve({ headers: { "x-api-key": plaintext } });
  assert.equal(viaApiKeyHeader.id, "key-user");

  // Falls back to dev when nothing else present.
  const viaDev = await resolver.resolve({ headers: {} });
  assert.equal(viaDev.id, "dev-fallback");
});

test("resolver throws UnauthorizedError when no dev fallback", async () => {
  const resolver = new AuthResolver({});
  await assert.rejects(resolver.resolve({ headers: {} }), UnauthorizedError);
});

// --- enforce() RBAC bridge -------------------------------------------------

test("enforce allows platform_admin across tenants", () => {
  const admin: Principal = { id: "root", type: "user", roles: ["platform_admin"] };
  assert.doesNotThrow(() => enforce(admin, "pipeline:create", { tenantId: "any-tenant" }));
});

test("enforce denies cross-tenant access", () => {
  const operator: Principal = { id: "op", type: "user", tenantId: "tenant-a", roles: ["tenant_operator"] };
  assert.throws(() => enforce(operator, "pipeline:run", { tenantId: "tenant-b" }), AuthorizationError);
  // Same tenant is allowed.
  assert.doesNotThrow(() => enforce(operator, "pipeline:run", { tenantId: "tenant-a" }));
  // Tenant scoping defaults to the principal's own tenant.
  assert.doesNotThrow(() => enforce(operator, "pipeline:run"));
});

test("enforce denies missing permission", () => {
  const viewer: Principal = { id: "v", type: "user", tenantId: "tenant-a", roles: ["viewer"] };
  assert.throws(() => enforce(viewer, "pipeline:delete"), AuthorizationError);
});
