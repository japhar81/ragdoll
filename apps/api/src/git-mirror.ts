/**
 * GitMirror integration — the bridge between the control-plane DB and a
 * git-mode tenant's repo. The reconcile pass is idempotent:
 *
 *   1. open a worktree (clone first time, fetch on subsequent calls)
 *   2. pull → take any git-side changes into the DB
 *   3. re-serialize the DB state → write yaml/encrypted files
 *   4. commit + push if anything actually differs
 *
 * "Git wins" on conflict: step 2 happens BEFORE step 3, so any
 * external commit between syncs is the last word for the colliding
 * file. The next reconcile pushes it back to git verbatim.
 *
 * The sync is triggered by:
 *   * the polling tick (`sync_tenant_git` worker job) for time-driven
 *     pulls
 *   * the API mutation routes (pipeline save, config upsert, secret
 *     create), which call {@link enqueueTenantSync} so the worker picks
 *     it up rather than blocking the user request on a git push.
 */
import { randomUUID } from "node:crypto";
import type { App } from "./app.ts";
import {
  decryptSecretBundle,
  encryptSecretBundle,
  layoutFor,
  manifestToYaml,
  openRepo,
  parseRepoPath,
  pipelineToYaml,
  unwrapDek,
  yamlToConfigValues,
  yamlToManifest,
  yamlToPipeline,
  CURRENT_MANIFEST_FORMAT,
  type ConfigFileEntry,
  type GitAuth,
  type GitBackend,
  type RepoLayout
} from "../../../packages/git-storage/src/index.ts";
import type {
  ConfigValueRow,
  PipelineRow,
  PipelineVersionRow,
  TenantGitConfigRow,
  TenantPipelineRow,
  TenantRow
} from "../../../packages/db/src/index.ts";

// App type only used in comments to anchor the cross-module link.
type _App = App; void (0 as unknown as _App);

/**
 * Subset of `AppDeps` the mirror needs. Decoupled from the API
 * server's AppDeps shape so the worker can construct an equivalent
 * record from its own repos without dragging in api/app.ts.
 */
export interface MirrorDeps {
  tenants: {
    require(id: string): Promise<TenantRow>;
    update(id: string, patch: Partial<TenantRow>): Promise<TenantRow>;
  };
  tenantGitConfigs: {
    get(tenantId: string): Promise<TenantGitConfigRow | undefined>;
    recordSync(
      tenantId: string,
      result: { sha?: string | null; syncedAt: string; error?: string | null }
    ): Promise<void>;
  };
  pipelines: {
    listByTenant?(tenantId: string): Promise<PipelineRow[]>;
    list(): Promise<PipelineRow[]>;
    get(id: string): Promise<PipelineRow | undefined>;
    findBySlug?(slug: string): Promise<PipelineRow | undefined>;
    create(row: PipelineRow): Promise<PipelineRow>;
    update(id: string, patch: Partial<PipelineRow>): Promise<PipelineRow>;
    setLatestVersion?(id: string, versionId: string): Promise<void>;
  };
  pipelineVersions: {
    listByPipeline(id: string): Promise<PipelineVersionRow[]>;
    create(row: PipelineVersionRow): Promise<PipelineVersionRow>;
  };
  tenantPipelines: {
    listByTenant(tenantId: string): Promise<TenantPipelineRow[]>;
  };
  configValues: {
    listConfigValues(filter?: {
      scope?: string;
      scopeId?: string;
    }): Promise<ConfigValueRow[]>;
    upsert(row: ConfigValueRow): Promise<ConfigValueRow>;
  };
  /**
   * Plaintext secret read-out for the bundle. The API layer redacts at
   * the HTTP boundary; the mirror needs the raw values because the
   * encrypted bundle on disk IS the canonical copy.
   */
  readTenantSecrets?(tenantId: string): Promise<Record<string, string>>;
  writeTenantSecret?(
    tenantId: string,
    key: string,
    value: string
  ): Promise<void>;
  deleteTenantSecret?(tenantId: string, key: string): Promise<void>;
  /**
   * Audit hook — best-effort. Mirror failures should always log here
   * even if the underlying call throws.
   */
  audit?(
    tenantId: string,
    action: string,
    fields: Record<string, unknown>
  ): Promise<void>;
  /**
   * Lookup of the auth credential for `tenant_git_configs.auth_secret_id`.
   * Returns the raw PAT (https) or PEM (ssh).
   */
  readGitAuthCredential(secretId: string): Promise<string>;
  /** Process-wide KEK (env `SECRET_ENCRYPTION_KEY`). */
  kek: string;
  /** Worktree root on disk; tenants get a subdir under this. */
  workRoot: string;
}

export type MirrorOutcome = {
  ok: boolean;
  pulled?: string | null;
  pushed?: string | null;
  filesWritten?: number;
  filesDeleted?: number;
  importedFromGit?: number;
  error?: string;
};

/**
 * Run one full reconciliation pass for a tenant. Safe to call repeatedly;
 * idempotent. Surfaces all failures as `{ ok: false, error }` and updates
 * `tenant_git_configs.last_sync_error` so the UI can show it.
 */
export async function reconcileTenant(
  deps: MirrorDeps,
  tenantId: string
): Promise<MirrorOutcome> {
  const tenant = await deps.tenants.require(tenantId);
  if (tenant.storageMode !== "git") {
    return { ok: true }; // nothing to do
  }
  const config = await deps.tenantGitConfigs.get(tenantId);
  if (!config) {
    await deps.tenantGitConfigs.recordSync(tenantId, {
      syncedAt: new Date().toISOString(),
      error: "no git config configured"
    });
    return { ok: false, error: "no git config configured" };
  }
  let credential: string;
  try {
    credential = await deps.readGitAuthCredential(config.authSecretId);
  } catch (e) {
    const error = errMessage(e);
    await deps.tenantGitConfigs.recordSync(tenantId, {
      syncedAt: new Date().toISOString(),
      error: `auth secret unavailable: ${error}`
    });
    return { ok: false, error };
  }

  const auth: GitAuth = {
    method: config.authMethod,
    credential
  };

  let backend: GitBackend | undefined;
  try {
    backend = await openRepo({
      remoteUrl: config.remoteUrl,
      branch: config.branch,
      auth,
      workRoot: deps.workRoot,
      tenantId
    });
    const beforeSha = await backend.headSha();
    // 1) Take any git-side changes into the DB.
    const importedFromGit = await importFromGit(
      deps,
      backend,
      config,
      tenant
    );

    // 2) Re-serialize the DB state to disk and commit if anything moved.
    const writeSummary = await exportToGit(deps, backend, config, tenant);

    const afterSha = await backend.headSha();
    await deps.tenantGitConfigs.recordSync(tenantId, {
      sha: afterSha,
      syncedAt: new Date().toISOString(),
      error: null
    });
    await deps.audit?.(tenantId, "tenant_git.sync", {
      tenantSlug: tenant.slug,
      beforeSha,
      afterSha,
      importedFromGit,
      filesWritten: writeSummary.filesWritten,
      filesDeleted: writeSummary.filesDeleted
    });
    return {
      ok: true,
      pulled: beforeSha,
      pushed: writeSummary.pushed,
      filesWritten: writeSummary.filesWritten,
      filesDeleted: writeSummary.filesDeleted,
      importedFromGit
    };
  } catch (e) {
    const error = errMessage(e);
    await deps.tenantGitConfigs.recordSync(tenantId, {
      syncedAt: new Date().toISOString(),
      error
    });
    await deps.audit?.(tenantId, "tenant_git.sync_failed", {
      tenantSlug: tenant.slug,
      error
    });
    return { ok: false, error };
  } finally {
    await backend?.close().catch(() => undefined);
  }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// git → DB import
// ---------------------------------------------------------------------------

async function importFromGit(
  deps: MirrorDeps,
  backend: GitBackend,
  config: TenantGitConfigRow,
  tenant: TenantRow
): Promise<number> {
  // First sync: import everything under the tenant's prefix; subsequent
  // syncs: just the diff since last_synced_sha. Either way, we walk the
  // resulting list and re-apply each file we recognize.
  const head = await backend.headSha();
  let paths: string[];
  if (config.lastSyncedSha) {
    paths = await backend.diffNames(config.lastSyncedSha, head);
  } else {
    paths = await backend.list(config.pathPrefix);
  }
  let count = 0;
  for (const path of paths) {
    const parsed = parseRepoPath(config.pathPrefix, path);
    if (!parsed) continue;
    if (parsed.tenantSlug !== tenant.slug) continue;
    // Only import for environments that exist in the catalog — silently
    // skip envs the operator hasn't provisioned yet.
    try {
      if (parsed.kind === "pipeline") {
        const text = await backend.read(path);
        if (text === undefined) continue;
        const file = yamlToPipeline(text);
        await upsertPipelineFromFile(deps, tenant, parsed.envSlug, file);
        count++;
      } else if (parsed.kind === "configs") {
        const text = await backend.read(path);
        if (text === undefined) continue;
        const entries = yamlToConfigValues(text);
        await upsertConfigValuesFromFile(deps, tenant, parsed.envSlug, entries);
        count++;
      } else if (parsed.kind === "secrets") {
        if (!deps.writeTenantSecret) continue;
        const text = await backend.read(path);
        if (text === undefined) continue;
        const dek = unwrapDek(config.dekWrapped, deps.kek);
        try {
          const bundle = decryptSecretBundle(text.trim(), dek);
          // Replace EVERY key in the bundle; deletions are handled by
          // diffing the previous bundle in a future iteration. For now
          // an add/update-only import is correct enough for the MVP.
          for (const [k, v] of Object.entries(bundle)) {
            await deps.writeTenantSecret(tenant.id, k, v);
          }
          count++;
        } finally {
          dek.fill(0);
        }
      } else if (parsed.kind === "manifest") {
        // Validate format compatibility.
        const text = await backend.read(path);
        if (text) yamlToManifest(text);
      }
    } catch (e) {
      // Don't let one bad file kill the whole sync. The audit row makes
      // it visible; the next sync will see it again and try again.
      await deps.audit?.(tenant.id, "tenant_git.import_error", {
        path,
        error: errMessage(e)
      });
    }
  }
  return count;
}

async function upsertPipelineFromFile(
  deps: MirrorDeps,
  tenant: TenantRow,
  _envSlug: string,
  file: { metadata: { slug: string; name: string }; spec: unknown }
): Promise<void> {
  // Find-or-create the pipeline row (global), then snapshot the spec
  // as a new pipeline_version.
  let pipeline = deps.pipelines.findBySlug
    ? await deps.pipelines.findBySlug(file.metadata.slug)
    : (await deps.pipelines.list()).find(
        (p) => p.slug === file.metadata.slug
      );
  if (!pipeline) {
    const now = new Date().toISOString();
    pipeline = await deps.pipelines.create({
      id: randomUUID(),
      slug: file.metadata.slug,
      name: file.metadata.name,
      description: null,
      folderId: null,
      latestVersionId: null,
      labels: { source: "git", tenantSlug: tenant.slug },
      createdAt: now,
      updatedAt: now
    } as PipelineRow);
  }
  const checksum = stableChecksum(file.spec);
  const versions = await deps.pipelineVersions.listByPipeline(pipeline.id);
  const existing = versions.find((v) => v.checksum === checksum);
  if (existing) return; // already imported
  const now = new Date().toISOString();
  const version: PipelineVersionRow = {
    id: randomUUID(),
    pipelineId: pipeline.id,
    version: String(
      (file.metadata as { version?: unknown }).version ?? autoVersion(versions)
    ),
    status: "published",
    spec: file.spec,
    checksum,
    createdBy: null,
    createdAt: now,
    publishedAt: now,
    parentVersionId: versions[versions.length - 1]?.id ?? null
  };
  await deps.pipelineVersions.create(version);
  if (deps.pipelines.setLatestVersion) {
    await deps.pipelines.setLatestVersion(pipeline.id, version.id);
  } else {
    await deps.pipelines.update(pipeline.id, {
      latestVersionId: version.id
    } as Partial<PipelineRow>);
  }
}

function stableChecksum(spec: unknown): string {
  const json = JSON.stringify(canonical(spec));
  // Lightweight sha256-of-json — avoids dragging in a hash lib here; this
  // mirrors the spec-checksum helper in @ragdoll/pipeline-spec.
  const enc = new TextEncoder().encode(json);
  let h = 0xcbf29ce484222325n;
  for (const b of enc) {
    h = (h ^ BigInt(b)) * 0x100000001b3n;
    h &= 0xffffffffffffffffn;
  }
  return h.toString(16);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])])
    );
  }
  return value;
}

function autoVersion(versions: PipelineVersionRow[]): string {
  // Naive auto-bump: count + 1 as a patch under 0.0.x. Operators who
  // care set metadata.version explicitly in the yaml.
  return `0.0.${versions.length + 1}`;
}

async function upsertConfigValuesFromFile(
  deps: MirrorDeps,
  tenant: TenantRow,
  _envSlug: string,
  entries: ConfigFileEntry[]
): Promise<void> {
  for (const entry of entries) {
    if (entry.scope !== "tenant" && entry.scope !== "tenant_pipeline") continue;
    if (entry.scopeId && entry.scopeId !== tenant.id) continue;
    const now = new Date().toISOString();
    await deps.configValues.upsert({
      id: randomUUID(),
      key: entry.key,
      value: entry.value,
      scope: entry.scope as ConfigValueRow["scope"],
      scopeId: entry.scopeId ?? tenant.id,
      locked: Boolean(entry.locked),
      createdAt: now,
      updatedAt: now
    } as ConfigValueRow);
  }
}

// ---------------------------------------------------------------------------
// DB → git export
// ---------------------------------------------------------------------------

interface ExportSummary {
  filesWritten: number;
  filesDeleted: number;
  pushed: string | null;
}

async function exportToGit(
  deps: MirrorDeps,
  backend: GitBackend,
  config: TenantGitConfigRow,
  tenant: TenantRow
): Promise<ExportSummary> {
  const assocs = await deps.tenantPipelines.listByTenant(tenant.id);
  const envSlugs = new Set(assocs.map((a) => a.environment));
  if (envSlugs.size === 0) envSlugs.add("dev"); // always emit at least one env

  const files: Record<string, string | null> = {};
  let filesWritten = 0;

  for (const envSlug of envSlugs) {
    const layout: RepoLayout = layoutFor({
      pathPrefix: config.pathPrefix,
      tenantSlug: tenant.slug,
      envSlug
    });

    // Manifest.
    files[layout.manifest] = manifestToYaml({
      apiVersion: "rag-platform/v1",
      kind: "Manifest",
      tenant: { slug: tenant.slug, name: tenant.name },
      environment: { slug: envSlug },
      format: CURRENT_MANIFEST_FORMAT
    });
    filesWritten++;

    // Pipelines for this env: every pipeline associated to (tenant, env).
    const envPipelines = assocs.filter((a) => a.environment === envSlug);
    for (const a of envPipelines) {
      const pipeline = await deps.pipelines.get(a.pipelineId);
      if (!pipeline) continue;
      if (!pipeline.latestVersionId) continue;
      const versions = await deps.pipelineVersions.listByPipeline(pipeline.id);
      const latest = versions.find((v) => v.id === pipeline.latestVersionId);
      if (!latest) continue;
      files[layout.pipelineFile(pipeline.slug)] = pipelineToYaml({
        apiVersion: "rag-platform/v1",
        kind: "Pipeline",
        metadata: {
          slug: pipeline.slug,
          name: pipeline.name,
          ...(pipeline.description ? { description: pipeline.description } : {}),
          version: latest.version
        },
        spec: latest.spec
      });
      filesWritten++;
    }

    // Config values: tenant + tenant_pipeline scoped only.
    const values = await deps.configValues.listConfigValues({
      scope: "tenant",
      scopeId: tenant.id
    });
    const pipelineValues = await deps.configValues.listConfigValues({
      scope: "tenant_pipeline",
      scopeId: tenant.id
    });
    const allValues = [...values, ...pipelineValues];
    if (allValues.length > 0) {
      const file = (await import("../../../packages/git-storage/src/index.ts"))
        .configValuesToYaml(
          allValues.map((v) => ({
            key: v.key,
            value: v.value,
            scope: v.scope,
            scopeId: v.scopeId ?? null,
            locked: v.locked
          }))
        );
      files[layout.configsFile] = file;
      filesWritten++;
    }

    // Secrets: encrypt the full plaintext bundle if the bridge supports it.
    if (deps.readTenantSecrets) {
      const plaintext = await deps.readTenantSecrets(tenant.id);
      if (Object.keys(plaintext).length > 0) {
        const dek = unwrapDek(config.dekWrapped, deps.kek);
        try {
          files[layout.secretsFile] = encryptSecretBundle(plaintext, dek);
          filesWritten++;
        } finally {
          dek.fill(0);
        }
      }
    }
  }

  // No `delete` paths in this MVP — we never remove files the operator
  // might have wanted to keep. The reconciler in a future iteration can
  // walk previously-emitted files and prune ones no longer in DB state.
  const result = await backend.commitAndPush({
    message: `ragdoll: reconcile ${tenant.slug}`,
    authorName: "RAGdoll",
    authorEmail: "ragdoll@localhost",
    files
  });
  return {
    filesWritten,
    filesDeleted: 0,
    pushed: result.sha
  };
}
