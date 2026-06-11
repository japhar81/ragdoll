/**
 * Regression test for bulwark blocker #1: dataset-binding connection
 * secrets weren't resolved at execution time.
 *
 * Before the fix, `buildDatasetResolver` constructed a binding's
 * `connection` object with `secret: undefined` and left a comment
 * "resolved at acquireClient time, not here" — but `acquireClient`
 * never receives a SecretProvider, so credentialed drivers (neo4j,
 * postgres, mongo, …) silently saw `secret: undefined` and failed auth
 * at the driver. Meanwhile `/probe` on the same connection succeeded,
 * because the probe sweep resolved the secret itself.
 *
 * The fix threads a SecretProvider into DatasetResolverDeps and the
 * resolver resolves the secret the same way the probe sweep does. This
 * test locks the contract: when `deps.secrets` is present, the
 * resolved binding's connection carries the credential string.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildDatasetResolver } from "../src/dataset-resolver.ts";
import type {
  DatasetRepository,
  DatasetVersionRepository,
  DatasetAliasRepository,
  ConnectionRepository,
  DatasetRow,
  DatasetVersionRow,
  DatasetAliasRow,
  ConnectionRow
} from "../../db/src/index.ts";
import type { SecretProvider } from "../../secrets/src/index.ts";
import type { SecretRef } from "../../core/src/index.ts";

function fakeDatasetRepo(row: DatasetRow): DatasetRepository {
  return {
    async get(id: string) {
      return id === row.id ? row : undefined;
    },
    async resolveSlug(args: { slug: string }) {
      return args.slug === row.slug ? row : undefined;
    }
  } as unknown as DatasetRepository;
}

function fakeVersionRepo(row: DatasetVersionRow): DatasetVersionRepository {
  return {
    async get(id: string) {
      return id === row.id ? row : undefined;
    }
  } as unknown as DatasetVersionRepository;
}

function fakeAliasRepo(row: DatasetAliasRow | undefined): DatasetAliasRepository {
  return {
    async resolve(_dsId: string, _name: string) {
      return row;
    }
  } as unknown as DatasetAliasRepository;
}

function fakeConnectionRepo(row: ConnectionRow): ConnectionRepository {
  return {
    async resolveSlug(args: { slug: string }) {
      return args.slug === row.slug ? row : undefined;
    }
  } as unknown as ConnectionRepository;
}

/**
 * Test-shaped SecretProvider: just looks the key up in a map. Captures
 * every `.get()` call so we can assert the resolver passed the right
 * scope and key.
 */
function fakeSecretProvider(secrets: Record<string, string>): {
  provider: SecretProvider;
  calls: Array<{ ref: SecretRef; boundary: string | undefined }>;
} {
  const calls: Array<{ ref: SecretRef; boundary: string | undefined }> = [];
  const provider = {
    kind: "static",
    async put() {
      throw new Error("put not supported in this stub");
    },
    async get(ref: SecretRef, tenantBoundary?: string) {
      calls.push({ ref, boundary: tenantBoundary });
      const value = secrets[ref.key];
      if (value === undefined) throw new Error(`secret not found: ${ref.key}`);
      return value;
    },
    async delete() {
      throw new Error("delete not supported in this stub");
    },
    async list() {
      return [];
    }
  } as unknown as SecretProvider;
  return { provider, calls };
}

const tenantId = "tenant-a";
const dsRow: DatasetRow = {
  id: "ds-1",
  slug: "aws-graph",
  scope: "tenant",
  tenantId,
  environmentId: null,
  displayName: "AWS Graph",
  description: null,
  embeddingProfile: {},
  chunkSchema: {},
  currentVersionId: "ver-1",
  bindings: { target: { connection: "neo4j-prod" } },
  archivedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
} as unknown as DatasetRow;

const verRow: DatasetVersionRow = {
  id: "ver-1",
  datasetId: "ds-1",
  versionLabel: "1.0.0",
  status: "published",
  backendCollections: {},
  createdAt: new Date().toISOString()
} as unknown as DatasetVersionRow;

const aliasRow: DatasetAliasRow = {
  id: "alias-1",
  datasetId: "ds-1",
  name: "stable",
  versionId: "ver-1"
} as unknown as DatasetAliasRow;

const connRow: ConnectionRow = {
  id: "conn-1",
  slug: "neo4j-prod",
  kind: "neo4j",
  scope: "tenant",
  tenantId,
  environmentId: null,
  displayName: "neo4j prod",
  description: null,
  config: { host: "neo4j", port: 7687 },
  secretRefKey: "NEO4J_CREDS",
  allowedHosts: null,
  denyPrivateNetworks: false,
  archivedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastProbeOk: null,
  lastProbeError: null,
  lastProbedAt: null
} as unknown as ConnectionRow;

// ---------------------------------------------------------------------------

test("resolver attaches connection.secret resolved through SecretProvider", async () => {
  const { provider, calls } = fakeSecretProvider({
    NEO4J_CREDS: '{"username":"neo4j","password":"hunter2"}'
  });
  const resolver = buildDatasetResolver({
    datasets: fakeDatasetRepo(dsRow),
    datasetVersions: fakeVersionRepo(verRow),
    datasetAliases: fakeAliasRepo(aliasRow),
    connections: fakeConnectionRepo(connRow),
    secrets: provider
  });
  const resolved = await resolver.resolve({
    ref: { slug: "aws-graph" },
    tenantId
  });
  assert.ok(resolved, "dataset should resolve");
  const binding = resolved!.bindings.target;
  assert.ok(binding?.connection, "binding should carry a resolved connection");
  assert.equal(binding!.connection!.kind, "neo4j");
  assert.equal(
    binding!.connection!.secret,
    '{"username":"neo4j","password":"hunter2"}',
    "secret must travel on the binding-connection envelope (was undefined before the fix)"
  );
  // SecretProvider was called with the tenant-scoped ref the connection row pointed at.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].ref, {
    scope: "tenant",
    tenantId,
    key: "NEO4J_CREDS"
  });
  assert.equal(calls[0].boundary, tenantId);
});

test("resolver leaves connection.secret undefined when deps.secrets omitted (legacy)", async () => {
  // Pre-fix shape: callers that don't pass deps.secrets still get a
  // resolved binding, just without a credential. Drivers can surface
  // their own "missing creds" error.
  const resolver = buildDatasetResolver({
    datasets: fakeDatasetRepo(dsRow),
    datasetVersions: fakeVersionRepo(verRow),
    datasetAliases: fakeAliasRepo(aliasRow),
    connections: fakeConnectionRepo(connRow)
  });
  const resolved = await resolver.resolve({
    ref: { slug: "aws-graph" },
    tenantId
  });
  assert.equal(resolved?.bindings.target.connection?.secret, undefined);
});

test("resolver tolerates SecretProvider.get failure (binding stays usable, secret stays undefined)", async () => {
  // A missing secret in the provider doesn't break dataset resolution —
  // it just leaves the binding usable for no-auth drivers and lets
  // credentialed drivers raise their own clear error at execute.
  const { provider } = fakeSecretProvider({/* empty: every get rejects */});
  const resolver = buildDatasetResolver({
    datasets: fakeDatasetRepo(dsRow),
    datasetVersions: fakeVersionRepo(verRow),
    datasetAliases: fakeAliasRepo(aliasRow),
    connections: fakeConnectionRepo(connRow),
    secrets: provider
  });
  const resolved = await resolver.resolve({
    ref: { slug: "aws-graph" },
    tenantId
  });
  assert.ok(resolved);
  assert.ok(resolved!.bindings.target.connection, "connection still attached");
  assert.equal(resolved!.bindings.target.connection!.secret, undefined);
});
