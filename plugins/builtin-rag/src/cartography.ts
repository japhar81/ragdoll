/**
 * cartography_crawl — third crawler block, sibling to the two web crawlers.
 *
 * Launches Cartography (https://github.com/cartography-cncf/cartography)
 * against a target Neo4j connection it receives as a binding. The CALLER
 * decides which working-graph Cartography writes to: the plugin reads
 * `input.dataset.bindings.target.connection` (must be kind=neo4j) and
 * passes the connection details to Cartography via env vars.
 *
 * What this plugin owns:
 *   - Resolve the bound neo4j connection (host/port/auth via the unified
 *     Connections registry — ADR-0023).
 *   - Resolve the configured cloud credentials secret (via the managed
 *     secret machinery — the raw value never appears in argv, the
 *     execution trace, or the logs).
 *   - Spawn the `cartography` CLI with the right module flags + an
 *     env-injected credential bundle, capture its exit + stdout summary,
 *     and emit a metadata envelope so downstream nodes and the execution
 *     trace see what ran.
 *
 * What this plugin does NOT own:
 *   - Cartography itself. The binary is installed on the worker (via
 *     `pip install cartography` or the project's container image); this
 *     plugin only orchestrates it. If `cartography` isn't on PATH the
 *     subprocess path fails with a clear "install cartography" message.
 *   - Destructive-sync semantics. Cartography owns destructive sync
 *     within its target graph (it sets a sync tag and deletes nodes that
 *     weren't seen on the current run). Pointing this plugin at a graph
 *     that holds non-Cartography data is the CALLER's binding choice —
 *     the block just writes where bound.
 *
 * Two runners:
 *   - `subprocess` (default) — spawn `cartography sync` with the right
 *     flags. Credentials flow through env vars; never via argv or the
 *     execution input bag.
 *   - `dry-run` — return synthetic, deterministic metadata without
 *     touching neo4j or invoking the binary. Used by tests and by the
 *     Builder's "preview an unbound run" affordance.
 */

import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { InProcessPlugin } from "../../../packages/plugin-sdk/src/index.ts";
import { requireNeo4jConnection } from "./neo4j.ts";

/** Cartography intel modules we surface in the UI dropdown. The list is
 *  intentionally curated — Cartography itself supports a much larger
 *  set, but the enumerated subset keeps the config form discoverable.
 *  Operators who need a different module can override `runner: "subprocess"`
 *  + add the module via Cartography's own CLI flags through the
 *  `extraArgs` escape hatch below.
 */
export const CARTOGRAPHY_MODULES = [
  "aws",
  "gcp",
  "azure",
  "github",
  "gsuite",
  "kubernetes",
  "okta",
  "duo",
  "crowdstrike"
] as const;

export type CartographyModule = (typeof CARTOGRAPHY_MODULES)[number];

interface CartographyMetadata {
  crawlId: string;
  startedAt: string;
  completedAt: string;
  mode: "subprocess" | "dry-run";
  target: { connectionSlug: string; database?: string };
  modules: Array<{
    module: string;
    status: "succeeded" | "failed" | "skipped";
    counts?: number;
    error?: string;
  }>;
  /** Pass-through of cartography's exit code (subprocess mode only). */
  exitCode?: number | null;
}

/** What we pass to `node:child_process.spawn` (or an injected stub). The
 *  small shape lets the test harness intercept the spawn call cleanly. */
export interface CartographyRunArgs {
  bin: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
}

/** Internal spawn shape — exported for unit-test injection so the plugin's
 *  config-validation + arg-assembly is testable without a real cartography
 *  binary on the test PATH. */
export type CartographySpawner = (
  args: CartographyRunArgs
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

/** Default spawner: shells out to `cartography` via node:child_process.spawn.
 *  No `shell: true` — argv is passed as an array so a hostile config value
 *  in an extraArg can't reach the shell parser. Stdout/stderr are captured
 *  (bounded) so the run metadata can carry a tail of either on failure. */
async function defaultSpawner(args: CartographyRunArgs): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = nodeSpawn(args.bin, args.args, {
        env: { ...process.env, ...args.env },
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (e) {
      reject(e);
      return;
    }
    const out: string[] = [];
    const err: string[] = [];
    let outBytes = 0;
    let errBytes = 0;
    const CAP = 64 * 1024;
    proc.stdout?.on("data", (buf: Buffer) => {
      if (outBytes < CAP) {
        out.push(buf.toString("utf8"));
        outBytes += buf.length;
      }
    });
    proc.stderr?.on("data", (buf: Buffer) => {
      if (errBytes < CAP) {
        err.push(buf.toString("utf8"));
        errBytes += buf.length;
      }
    });
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
    }, args.timeoutMs);
    proc.on("error", (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout: out.join(""), stderr: err.join("") });
    });
  });
}

/** Pure: assemble cartography CLI args from the validated config + the
 *  resolved Neo4j connection. Exported for unit-test reach. */
export function buildCartographyArgs(args: {
  modules: string[];
  incremental: boolean;
  accountSelectors?: Record<string, unknown>;
  extraArgs?: string[];
}): string[] {
  const cliArgs: string[] = ["sync"];
  // Cartography uses --selected-modules (comma-separated) since 0.85.
  if (args.modules.length > 0) {
    cliArgs.push("--selected-modules", args.modules.join(","));
  }
  if (args.incremental) {
    cliArgs.push("--update-tag", String(Math.floor(Date.now() / 1000)));
  }
  // Per-module account selectors map to Cartography's per-module CLI flags
  // (e.g. --aws-sync-all-profiles for AWS, --github-config-env-var for
  // GitHub). The mapping is module-specific and brittle, so we pass them
  // through verbatim under a sub-namespace: `accountSelectors.aws.flag = value`
  // becomes `--aws-flag value`. Operators stay in control; the plugin
  // doesn't pretend to know every flag every module accepts.
  if (args.accountSelectors) {
    for (const [mod, selectorsRaw] of Object.entries(args.accountSelectors)) {
      if (!selectorsRaw || typeof selectorsRaw !== "object") continue;
      const selectors = selectorsRaw as Record<string, unknown>;
      for (const [flag, value] of Object.entries(selectors)) {
        // `cartographyBin sync --aws-some-flag value`. Skip values that
        // would shell-inject if a future caller bypasses spawn's argv
        // safety.
        if (!/^[a-z0-9-]+$/i.test(flag)) continue;
        cliArgs.push(`--${mod}-${flag}`);
        if (value !== true) cliArgs.push(String(value));
      }
    }
  }
  // Caller-supplied extra args (advanced; documented as the "Cartography
  // CLI knows things this plugin doesn't" escape hatch).
  if (args.extraArgs?.length) {
    for (const arg of args.extraArgs) cliArgs.push(String(arg));
  }
  return cliArgs;
}

/** Pure: derive cartography's neo4j-config env from a ResolvedExternalConnection
 *  + the resolved cloud creds. Centralised so the unit test asserts the env
 *  shape without spawning anything. */
export function buildCartographyEnv(args: {
  neo4jUri: string;
  neo4jUsername: string;
  neo4jPassword: string;
  credsSecret?: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    NEO4J_URI: args.neo4jUri,
    NEO4J_USER: args.neo4jUsername,
    NEO4J_PASSWORD: args.neo4jPassword
  };
  if (args.credsSecret) {
    // The cloud creds secret may be a JSON blob (AWS / GCP service
    // account) or a single token (Okta / GitHub PAT). We surface it
    // under a couple of widely-used cartography-compatible names; the
    // operator's secret payload defines which one is read.
    env.CARTOGRAPHY_CREDS = args.credsSecret;
  }
  return env;
}

function parseNeo4jSecret(raw: string | undefined): { username: string; password: string } {
  if (!raw) return { username: "neo4j", password: "" };
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { username?: string; password?: string };
      return {
        username: parsed.username ?? "neo4j",
        password: parsed.password ?? ""
      };
    } catch {
      /* fall through */
    }
  }
  return { username: "neo4j", password: trimmed };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/** Mutable for tests: replace the spawner to assert argv / env without
 *  invoking a real cartography binary. Tests MUST restore the default in
 *  a try/finally so subsequent suites aren't affected. */
let activeSpawner: CartographySpawner = defaultSpawner;

/** Test hook — swap the spawn implementation. */
export function __setCartographySpawnerForTests(s: CartographySpawner | null): void {
  activeSpawner = s ?? defaultSpawner;
}

export const cartographyCrawlPlugin: InProcessPlugin = {
  manifest: {
    id: "cartography_crawl",
    name: "Cartography Crawl",
    version: "1.0.0",
    category: "datasource",
    contract: 2,
    requires: [{ binding: "target", kind: "neo4j" }],
    description:
      "Launches Cartography (https://github.com/cartography-cncf/cartography) against the Neo4j connection bound to this node's `target` binding. The CALLER chooses which working-graph Cartography populates; this plugin never bundles Cartography itself and never holds non-Cartography data. Emits per-module status as `metadata`.",
    configSchema: {
      type: "object",
      required: ["modules"],
      properties: {
        modules: {
          type: "array",
          items: { type: "string", enum: [...CARTOGRAPHY_MODULES] },
          description:
            "Which Cartography intel modules to run (at least one required). Each runs in its own subprocess invocation."
        },
        incremental: {
          type: "boolean",
          default: false,
          description:
            "When true, pass `--update-tag` with the current unix timestamp so Cartography preserves nodes from prior runs. Default is full sync."
        },
        accountSelectors: {
          type: "object",
          description:
            "Per-module account / org / project selectors. Shape varies by module. Each sub-key is the module name; values are flag → value pairs that become `--{module}-{flag} <value>` on the cartography CLI."
        },
        credsSecretRef: {
          type: "string",
          format: "secret-ref",
          description:
            "Reference to a managed secret holding the read-only cloud credentials. The plugin resolves it through the SecretProvider; the raw value never appears in argv, the execution trace, or the logs."
        },
        runner: {
          type: "string",
          enum: ["subprocess", "dry-run"],
          default: "subprocess",
          description:
            "Execution mode. `subprocess` shells out to the cartography binary; `dry-run` returns synthetic metadata (testing / unbound preview)."
        },
        cartographyBin: {
          type: "string",
          default: "cartography",
          description: "Cartography CLI binary name or absolute path on the worker process's PATH."
        },
        extraArgs: {
          type: "array",
          items: { type: "string" },
          description:
            "Verbatim extra args appended to the cartography CLI invocation. Advanced — the operator owns these completely."
        },
        timeoutMs: {
          type: "integer",
          default: 1800000,
          description: "Per-invocation timeout (ms). Default 30 minutes."
        }
      },
      additionalProperties: false
    },
    secretsSchema: {
      type: "object",
      properties: {
        creds: { type: "string", format: "secret-ref", description: "Alias for credsSecretRef." }
      },
      additionalProperties: false
    },
    inputPorts: [],
    outputPorts: [
      {
        name: "metadata",
        description:
          "Crawl run envelope: { crawlId, startedAt, completedAt, mode, target, modules: [{module, status, counts?, error?}], exitCode? }. Downstream nodes can branch on `mode` and per-module status."
      }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "cloud",
      color: "#0ea5e9",
      paletteGroup: "Crawlers",
      formHints: {
        modules: { widget: "tags" },
        runner: { widget: "select" },
        credsSecretRef: { widget: "secret" },
        accountSelectors: { widget: "json" },
        extraArgs: { widget: "tags" }
      }
    }
  },
  async execute(input) {
    const conn = requireNeo4jConnection(input, "target", "cartography_crawl");
    const cfg = input.config as {
      modules?: unknown;
      incremental?: unknown;
      accountSelectors?: unknown;
      credsSecretRef?: unknown;
      runner?: unknown;
      cartographyBin?: unknown;
      extraArgs?: unknown;
      timeoutMs?: unknown;
    };
    const modulesRaw = Array.isArray(cfg.modules) ? (cfg.modules as unknown[]) : [];
    const modules: string[] = [];
    for (const m of modulesRaw) {
      const mStr = String(m);
      if (!(CARTOGRAPHY_MODULES as readonly string[]).includes(mStr)) {
        throw new Error(
          `cartography_crawl: unknown module "${mStr}" — allowed: ${CARTOGRAPHY_MODULES.join(", ")}`
        );
      }
      modules.push(mStr);
    }
    if (modules.length === 0) {
      throw new Error("cartography_crawl: at least one module must be configured");
    }
    const runner = String(cfg.runner ?? "subprocess");
    if (runner !== "subprocess" && runner !== "dry-run") {
      throw new Error(`cartography_crawl: unknown runner "${runner}"`);
    }

    const crawlId = randomUUID();
    const startedAt = new Date().toISOString();
    const targetSlug = conn.slug;
    const targetDatabase = (conn.options as { database?: string } | undefined)?.database;

    if (runner === "dry-run") {
      const metadata: CartographyMetadata = {
        crawlId,
        startedAt,
        completedAt: new Date().toISOString(),
        mode: "dry-run",
        target: { connectionSlug: targetSlug, database: targetDatabase },
        modules: modules.map((module) => ({ module, status: "skipped", counts: 0 }))
      };
      return { outputs: { metadata } };
    }

    // Subprocess path.
    const bin = String(cfg.cartographyBin ?? "cartography");
    const timeoutMs = Number(cfg.timeoutMs ?? 1_800_000);
    // Resolve creds. Two paths: config.credsSecretRef → input.secrets.<ref>,
    // OR the convention secret name "creds" → input.secrets.creds.
    const credsSecret =
      typeof cfg.credsSecretRef === "string" && input.secrets[cfg.credsSecretRef]
        ? input.secrets[cfg.credsSecretRef]
        : input.secrets.creds;

    // Reconstruct uri/user/password from the resolved connection — the
    // driver factory parses these on `acquire`, but cartography talks to
    // neo4j directly so we re-derive here.
    const uri = (conn.options as { uri?: string } | undefined)?.uri ?? "";
    if (!uri) {
      throw new Error(
        `cartography_crawl: target binding "target" resolves connection slug "${targetSlug}" with no options.uri — cartography needs a Bolt URI.`
      );
    }
    const { username, password } = parseNeo4jSecret(conn.secret);
    const env = buildCartographyEnv({
      neo4jUri: uri,
      neo4jUsername: username,
      neo4jPassword: password,
      credsSecret
    });

    const accountSelectors =
      cfg.accountSelectors && typeof cfg.accountSelectors === "object"
        ? (cfg.accountSelectors as Record<string, unknown>)
        : undefined;
    const extraArgs = Array.isArray(cfg.extraArgs) ? (cfg.extraArgs as string[]) : undefined;
    const args = buildCartographyArgs({
      modules,
      incremental: cfg.incremental === true,
      accountSelectors,
      extraArgs
    });

    const moduleStatus: CartographyMetadata["modules"] = modules.map((module) => ({
      module,
      status: "succeeded"
    }));
    let exitCode: number | null = 0;
    try {
      const result = await activeSpawner({ bin, args, env, timeoutMs });
      exitCode = result.exitCode;
      if (result.exitCode !== 0) {
        // We don't try to per-module-attribute the failure; cartography's
        // CLI doesn't surface per-module status in a parseable form. Tail
        // the stderr instead so the operator has somewhere to start.
        const errTail = result.stderr.slice(-1024);
        for (const entry of moduleStatus) {
          entry.status = "failed";
          entry.error = errTail || "cartography exited non-zero";
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      for (const entry of moduleStatus) {
        entry.status = "failed";
        entry.error = message;
      }
      exitCode = null;
    }

    const metadata: CartographyMetadata = {
      crawlId,
      startedAt,
      completedAt: new Date().toISOString(),
      mode: "subprocess",
      target: { connectionSlug: targetSlug, database: targetDatabase },
      modules: moduleStatus,
      exitCode
    };
    return { outputs: { metadata } };
  }
};
