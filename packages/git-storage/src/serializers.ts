/**
 * Lossless yaml/json round-tripping for the artifacts a git-mode
 * tenant's repo holds:
 *
 *   - PipelineSpec ↔ pipelines/<slug>.yaml
 *   - Config values bundle ↔ configs/values.yaml
 *   - Secrets manifest (key list only; values come via crypto.ts) ↔
 *     the JSON we hand off to the encryptor before writing values.enc
 *   - The per-(tenant, env) manifest.yaml (header only)
 *
 * Schemas are kept stable & explicit so people editing files by hand
 * can rely on what they wrote being what came back.
 */
import { parseYaml, stringifyYaml } from "../../pipeline-spec/src/yaml.ts";

// ---- Pipelines ------------------------------------------------------------

export interface PipelineFileShape {
  apiVersion: string; // pinned to "rag-platform/v1"
  kind: "Pipeline";
  metadata: {
    /** Stable slug; matches the file name. */
    slug: string;
    /** Human display name. */
    name: string;
    description?: string;
    /** Semver string of the version represented by this file. */
    version?: string;
  };
  spec: unknown;
}

export function pipelineToYaml(file: PipelineFileShape): string {
  return stringifyYaml(file);
}

export function yamlToPipeline(text: string): PipelineFileShape {
  const parsed = parseYaml(text) as Partial<PipelineFileShape>;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("pipeline file: not an object");
  }
  if (parsed.kind !== "Pipeline") {
    throw new Error(`pipeline file: kind must be "Pipeline", got ${String(parsed.kind)}`);
  }
  if (!parsed.metadata || typeof parsed.metadata !== "object") {
    throw new Error("pipeline file: metadata missing");
  }
  if (typeof parsed.metadata.slug !== "string") {
    throw new Error("pipeline file: metadata.slug missing");
  }
  if (typeof parsed.metadata.name !== "string") {
    throw new Error("pipeline file: metadata.name missing");
  }
  if (parsed.spec === undefined) {
    throw new Error("pipeline file: spec missing");
  }
  return parsed as PipelineFileShape;
}

// ---- Config values --------------------------------------------------------

export interface ConfigFileEntry {
  key: string;
  value: unknown;
  scope: string;
  scopeId?: string | null;
  locked?: boolean;
}

export interface ConfigFileShape {
  apiVersion: string;
  kind: "ConfigValues";
  /** Always sorted by `key` then `scope` so commits diff cleanly. */
  values: ConfigFileEntry[];
}

export function configValuesToYaml(entries: ConfigFileEntry[]): string {
  const sorted = [...entries].sort((a, b) =>
    a.key === b.key ? a.scope.localeCompare(b.scope) : a.key.localeCompare(b.key)
  );
  const file: ConfigFileShape = {
    apiVersion: "rag-platform/v1",
    kind: "ConfigValues",
    values: sorted
  };
  return stringifyYaml(file);
}

export function yamlToConfigValues(text: string): ConfigFileEntry[] {
  const parsed = parseYaml(text) as Partial<ConfigFileShape>;
  if (!parsed || typeof parsed !== "object" || parsed.kind !== "ConfigValues") {
    throw new Error("config values file: expected kind=ConfigValues");
  }
  if (!Array.isArray(parsed.values)) {
    throw new Error("config values file: values must be an array");
  }
  for (const entry of parsed.values) {
    if (typeof entry?.key !== "string" || typeof entry?.scope !== "string") {
      throw new Error("config values file: each entry needs key+scope strings");
    }
  }
  return parsed.values;
}

// ---- Secrets (manifest of keys only; payload is encrypted separately) ----

export interface SecretBundle {
  /** Key → plaintext value. The encryption step (crypto.ts) turns this
   *  whole map into ciphertext before it ever hits the disk. */
  values: Record<string, string>;
}

// ---- Per-(tenant, env) manifest ------------------------------------------

export interface ManifestShape {
  apiVersion: string;
  kind: "Manifest";
  tenant: { slug: string; name: string };
  environment: { slug: string };
  /** Increment when the file layout changes; readers refuse newer than they know. */
  format: number;
}

export const CURRENT_MANIFEST_FORMAT = 1;

export function manifestToYaml(m: ManifestShape): string {
  return stringifyYaml(m);
}

export function yamlToManifest(text: string): ManifestShape {
  const parsed = parseYaml(text) as Partial<ManifestShape>;
  if (!parsed || parsed.kind !== "Manifest") {
    throw new Error("manifest file: expected kind=Manifest");
  }
  if (!parsed.tenant?.slug || !parsed.environment?.slug) {
    throw new Error("manifest file: tenant.slug + environment.slug required");
  }
  return parsed as ManifestShape;
}
