/**
 * File layout inside a git-mode tenant's repo.
 *
 *   <pathPrefix>/<tenantSlug>/<envSlug>/
 *     manifest.yaml          # tenant slug, env slug, format version
 *     pipelines/<slug>.yaml  # full PipelineSpec per file
 *     configs/values.yaml    # tenant- + env-scoped config values
 *     secrets/values.enc     # encrypted bundle (AES-256-GCM, DEK in DB)
 *
 * `pathPrefix` lets one repo host many tenants — caller picks the prefix
 * when configuring storage (e.g. "platform/" or just "").
 */

export interface RepoLayout {
  /** Where inside the repo this (tenant, env) lives. No leading slash. */
  envRoot: string;
  manifest: string;
  pipelineDir: string;
  pipelineFile: (slug: string) => string;
  configsFile: string;
  secretsFile: string;
}

function joinPath(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter((p) => p.length > 0)
    .join("/");
}

export function layoutFor(args: {
  pathPrefix: string;
  tenantSlug: string;
  envSlug: string;
}): RepoLayout {
  const envRoot = joinPath(args.pathPrefix, args.tenantSlug, args.envSlug);
  const pipelineDir = `${envRoot}/pipelines`;
  return {
    envRoot,
    manifest: `${envRoot}/manifest.yaml`,
    pipelineDir,
    pipelineFile: (slug) => `${pipelineDir}/${slug}.yaml`,
    configsFile: `${envRoot}/configs/values.yaml`,
    secretsFile: `${envRoot}/secrets/values.enc`
  };
}

/**
 * Parse a repo-relative path back into its (tenant, env, kind, subpath)
 * components. Used by the polling diff loop to figure out which DB
 * surface a changed file maps to. Returns `undefined` for paths that
 * don't belong to our layout.
 */
export function parseRepoPath(
  pathPrefix: string,
  repoPath: string
):
  | { tenantSlug: string; envSlug: string; kind: "pipeline"; pipelineSlug: string }
  | { tenantSlug: string; envSlug: string; kind: "configs" }
  | { tenantSlug: string; envSlug: string; kind: "secrets" }
  | { tenantSlug: string; envSlug: string; kind: "manifest" }
  | undefined {
  const prefix = pathPrefix.replace(/^\/+|\/+$/g, "");
  const segs = repoPath.replace(/^\/+/, "").split("/");
  if (prefix) {
    const prefixSegs = prefix.split("/");
    for (let i = 0; i < prefixSegs.length; i++) {
      if (segs[i] !== prefixSegs[i]) return undefined;
    }
    segs.splice(0, prefixSegs.length);
  }
  if (segs.length < 3) return undefined;
  const [tenantSlug, envSlug, kindFolder, ...rest] = segs;
  if (!tenantSlug || !envSlug || !kindFolder) return undefined;
  if (kindFolder === "manifest.yaml" && rest.length === 0) {
    return { tenantSlug, envSlug, kind: "manifest" };
  }
  if (kindFolder === "pipelines" && rest.length === 1) {
    const file = rest[0];
    if (!file.endsWith(".yaml")) return undefined;
    return {
      tenantSlug,
      envSlug,
      kind: "pipeline",
      pipelineSlug: file.slice(0, -".yaml".length)
    };
  }
  if (kindFolder === "configs" && rest.join("/") === "values.yaml") {
    return { tenantSlug, envSlug, kind: "configs" };
  }
  if (kindFolder === "secrets" && rest.join("/") === "values.enc") {
    return { tenantSlug, envSlug, kind: "secrets" };
  }
  return undefined;
}
