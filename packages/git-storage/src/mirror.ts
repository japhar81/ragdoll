/**
 * GitMirror — the operations layer that translates control-plane
 * intents into git operations. Sits between API write handlers and the
 * raw {@link GitBackend}, applying the tenant's layout and the secrets
 * encryption envelope.
 *
 * Lifecycle per call:
 *   1. open() a worktree from the tenant's git config (clone if missing)
 *   2. one or more write* / read* calls
 *   3. close() to flush the worktree's auth secret material
 *
 * Higher-level callers (sync handler, route mutations) compose these
 * into "mirror this pipeline" / "mirror this config" / "mirror this
 * secret" operations.
 */
import { openRepo, type CommitOptions, type GitAuth, type GitBackend } from "./backend.ts";
import {
  decryptSecretBundle,
  encryptSecretBundle,
  unwrapDek
} from "./crypto.ts";
import { layoutFor, type RepoLayout } from "./layout.ts";
import {
  configValuesToYaml,
  CURRENT_MANIFEST_FORMAT,
  manifestToYaml,
  pipelineToYaml,
  yamlToConfigValues,
  yamlToManifest,
  yamlToPipeline,
  type ConfigFileEntry,
  type PipelineFileShape
} from "./serializers.ts";

export interface GitMirrorContext {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  envSlug: string;
  remoteUrl: string;
  branch: string;
  pathPrefix: string;
  auth: GitAuth;
  /** Wrapped DEK from `tenant_git_configs.dek_wrapped`. */
  dekWrapped: string;
  /** Instance KEK (process env `SECRET_ENCRYPTION_KEY`). */
  kek: string;
  /** Worktree root on disk; tenants get a subdir under this. */
  workRoot: string;
}

export interface GitMirror {
  layout: RepoLayout;
  backend: GitBackend;
  ensureManifest(): Promise<void>;
  writePipeline(file: PipelineFileShape, message?: string): Promise<void>;
  deletePipeline(slug: string, message?: string): Promise<void>;
  readPipeline(slug: string): Promise<PipelineFileShape | undefined>;
  listPipelineFiles(): Promise<string[]>;
  writeConfigValues(values: ConfigFileEntry[], message?: string): Promise<void>;
  readConfigValues(): Promise<ConfigFileEntry[]>;
  writeSecretBundle(values: Record<string, string>, message?: string): Promise<void>;
  readSecretBundle(): Promise<Record<string, string>>;
  close(): Promise<void>;
}

const AUTHOR = { name: "RAGdoll", email: "ragdoll@localhost" };

export async function openGitMirror(ctx: GitMirrorContext): Promise<GitMirror> {
  const backend = await openRepo({
    remoteUrl: ctx.remoteUrl,
    branch: ctx.branch,
    auth: ctx.auth,
    workRoot: ctx.workRoot,
    tenantId: ctx.tenantId
  });
  const layout = layoutFor({
    pathPrefix: ctx.pathPrefix,
    tenantSlug: ctx.tenantSlug,
    envSlug: ctx.envSlug
  });
  const dek = unwrapDek(ctx.dekWrapped, ctx.kek);

  const commit = async (files: CommitOptions["files"], message: string): Promise<void> => {
    await backend.commitAndPush({
      message: `ragdoll: ${message}`,
      authorName: AUTHOR.name,
      authorEmail: AUTHOR.email,
      files
    });
  };

  const mirror: GitMirror = {
    layout,
    backend,

    async ensureManifest(): Promise<void> {
      const existing = await backend.read(layout.manifest);
      if (existing) {
        // Refuse to read a newer format than we know — the operator
        // probably upgraded one process but not the others.
        const m = yamlToManifest(existing);
        if (m.format > CURRENT_MANIFEST_FORMAT) {
          throw new Error(
            `manifest format ${m.format} is newer than this build supports (${CURRENT_MANIFEST_FORMAT})`
          );
        }
        return;
      }
      const text = manifestToYaml({
        apiVersion: "rag-platform/v1",
        kind: "Manifest",
        tenant: { slug: ctx.tenantSlug, name: ctx.tenantName },
        environment: { slug: ctx.envSlug },
        format: CURRENT_MANIFEST_FORMAT
      });
      await commit(
        { [layout.manifest]: text },
        `init ${ctx.tenantSlug}/${ctx.envSlug}`
      );
    },

    async writePipeline(file, message): Promise<void> {
      const path = layout.pipelineFile(file.metadata.slug);
      await commit(
        { [path]: pipelineToYaml(file) },
        message ?? `update pipeline ${file.metadata.slug}`
      );
    },

    async deletePipeline(slug, message): Promise<void> {
      await commit(
        { [layout.pipelineFile(slug)]: null },
        message ?? `delete pipeline ${slug}`
      );
    },

    async readPipeline(slug): Promise<PipelineFileShape | undefined> {
      const text = await backend.read(layout.pipelineFile(slug));
      return text ? yamlToPipeline(text) : undefined;
    },

    async listPipelineFiles(): Promise<string[]> {
      return backend.list(layout.pipelineDir);
    },

    async writeConfigValues(values, message): Promise<void> {
      await commit(
        { [layout.configsFile]: configValuesToYaml(values) },
        message ?? "update config values"
      );
    },

    async readConfigValues(): Promise<ConfigFileEntry[]> {
      const text = await backend.read(layout.configsFile);
      return text ? yamlToConfigValues(text) : [];
    },

    async writeSecretBundle(values, message): Promise<void> {
      const wire = encryptSecretBundle(values, dek);
      await commit(
        { [layout.secretsFile]: wire },
        message ?? "update secrets"
      );
    },

    async readSecretBundle(): Promise<Record<string, string>> {
      const text = await backend.read(layout.secretsFile);
      if (!text) return {};
      return decryptSecretBundle(text.trim(), dek);
    },

    async close(): Promise<void> {
      // Wipe the unwrapped DEK from memory best-effort.
      dek.fill(0);
      await backend.close();
    }
  };

  return mirror;
}
