/**
 * cartography_crawl — manifest only (external execution).
 *
 * The handler lives in the python-plugins sidecar
 * (`services/python-plugins/app/plugins/cartography_crawl_plugin.py`).
 * The TS file keeps:
 *
 *   - the manifest (configSchema / outputs / requires{kind:neo4j}) so the
 *     Connections + Datasets + Pipeline-Builder UIs can render a real
 *     form and the spec validator catches binding-kind mismatches at
 *     /validate without a round-trip,
 *   - the module allowlist, kept in sync with the Python sidecar so the
 *     dropdown stays accurate when an operator adds modules to one side
 *     of the wire without the other.
 *
 * Registration: handled by the plugin-loader's `registerExternalPlugins()`
 * pass — pointed at `process.env.PYTHON_PLUGIN_URL`. With that env var
 * unset, cartography_crawl simply isn't registered (matches the existing
 * behaviour for `crawl4ai_crawler` and `scrapy_spider`).
 *
 * Why external: the `cartography` Python CLI isn't installed in the Node
 * worker image, and bundling it would explode the image and force every
 * worker pod to carry every cloud-graph dependency. The python-plugins
 * sidecar already has the dep declared in its pyproject.toml, so the
 * call hops over Connect-RPC and the worker stays lean. See ADR-0025
 * for the full rationale.
 */

import type { PluginManifest } from "../../../packages/plugin-sdk/src/index.ts";

/** Cartography intel modules surfaced in the UI dropdown. Curated subset
 *  of cartography's catalog — operators who need an exotic module pass
 *  `extraArgs` (the python handler appends them verbatim to the CLI).
 *  Keep this list in sync with
 *  `services/python-plugins/app/plugins/cartography_crawl_plugin.py:CARTOGRAPHY_MODULES`. */
export const CARTOGRAPHY_MODULES = [
  "aws",
  "azure",
  "crowdstrike",
  "duo",
  "gcp",
  "github",
  "gsuite",
  "jamf",
  "kandji",
  "kubernetes",
  "lastpass",
  "oci",
  "okta",
  "pagerduty",
  "semgrep",
  "snipeit",
  "tailscale"
] as const;

export type CartographyModule = (typeof CARTOGRAPHY_MODULES)[number];

export const cartographyCrawlManifest: PluginManifest = {
  id: "cartography_crawl",
  name: "Cartography Crawl",
  version: "1.0.0",
  category: "datasource",
  contract: 2,
  // Cast through unknown — PluginManifest.requires is still typed
  // against the legacy `{modality, provider}` shape for back-compat
  // even though the validator and worker both accept the ADR-0023
  // `{binding, kind|kindOneOf}` form below. Same trick used by
  // neo4j_query / neo4j_write.
  requires: [{ binding: "target", kind: "neo4j" }] as unknown as PluginManifest["requires"],
  description:
    "Launches Cartography (https://github.com/cartography-cncf/cartography) against the Neo4j connection bound to this node's `target` binding. Runs in the python-plugins sidecar (ADR-0025) — cartography is installed there via pip, NOT in the Node worker image. The CALLER chooses which working-graph Cartography populates. Emits per-module status as `metadata`.",
  configSchema: {
    type: "object",
    required: ["modules"],
    properties: {
      modules: {
        type: "array",
        items: { type: "string", enum: [...CARTOGRAPHY_MODULES] },
        description:
          "Which Cartography intel modules to run (at least one required). Each runs in its own subprocess invocation inside the sidecar."
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
          "Reference to a managed secret holding the read-only cloud credentials. The runtime resolves it through the SecretProvider before the call; the raw value never appears in argv, the execution trace, or the logs."
      },
      runner: {
        type: "string",
        enum: ["subprocess", "dry-run"],
        default: "subprocess",
        description:
          "Execution mode. `subprocess` shells out to the cartography CLI inside the sidecar; `dry-run` returns synthetic metadata for the Builder's unbound-preview affordance and for tests."
      },
      cartographyBin: {
        type: "string",
        default: "/opt/cartography-venv/bin/cartography",
        description:
          "Path to the cartography CLI binary inside the python-plugins sidecar. Defaults to the isolated venv the Dockerfile creates (see ADR-0026 §#2 follow-up — cartography's eager intel imports mean its deps can't share the main poetry env). Override only when the operator installed cartography elsewhere in the image."
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
    formHints: {
      modules: { widget: "tags" },
      incremental: { widget: "checkbox" },
      runner: { widget: "select" },
      timeoutMs: { widget: "number", min: 60_000, step: 60_000 }
    }
  }
};
