/**
 * Disk-backed CLI config: api URL + bearer token + selected tenant.
 *
 * Stored as a JSON file under `~/.ragdoll/config.json` (override via
 * `RAGDOLL_CONFIG` env). All paths/IO live here so the rest of the CLI is
 * thin: commands read/write the config object and the http helper picks up
 * the credentials. Pure functions are tested directly.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CliConfig {
  /** Base URL of the API. Defaults to http://localhost:3001. */
  apiUrl: string;
  /** Bearer session token from `ragdoll login`. */
  token?: string;
  /** Long-lived API key (`rgd_...`). */
  apiKey?: string;
  /** Currently selected tenant UUID (sent as `x-tenant-id`). */
  tenantId?: string;
}

export const DEFAULT_API_URL = "http://localhost:3001";

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RAGDOLL_CONFIG && env.RAGDOLL_CONFIG.trim()) {
    return env.RAGDOLL_CONFIG;
  }
  return join(env.HOME ?? homedir(), ".ragdoll", "config.json");
}

/**
 * Layered defaults: env > on-disk > built-in. `RAGDOLL_API_URL` /
 * `RAGDOLL_TOKEN` / `RAGDOLL_API_KEY` / `RAGDOLL_TENANT_ID` override the file
 * so CI / shells can run authenticated without writing to `~/.ragdoll/`.
 */
export async function loadConfig(
  env: NodeJS.ProcessEnv = process.env
): Promise<CliConfig> {
  let onDisk: Partial<CliConfig> = {};
  try {
    const raw = await readFile(configPath(env), "utf8");
    onDisk = JSON.parse(raw) as Partial<CliConfig>;
  } catch {
    /* no config yet — first run */
  }
  return {
    apiUrl: env.RAGDOLL_API_URL ?? onDisk.apiUrl ?? DEFAULT_API_URL,
    token: env.RAGDOLL_TOKEN ?? onDisk.token,
    apiKey: env.RAGDOLL_API_KEY ?? onDisk.apiKey,
    tenantId: env.RAGDOLL_TENANT_ID ?? onDisk.tenantId
  };
}

export async function saveConfig(
  next: CliConfig,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const path = configPath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", {
    mode: 0o600
  });
}

/** Merge a patch onto whatever is currently saved (preserves unset fields). */
export async function patchConfig(
  patch: Partial<CliConfig>,
  env: NodeJS.ProcessEnv = process.env
): Promise<CliConfig> {
  const current = await loadConfig(env);
  const next: CliConfig = { ...current, ...patch };
  await saveConfig(next, env);
  return next;
}

/** Headers to send with every request given the active credentials. */
export function authHeadersFor(config: CliConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  if (config.apiKey) headers["x-api-key"] = config.apiKey;
  if (config.tenantId) headers["x-tenant-id"] = config.tenantId;
  return headers;
}
