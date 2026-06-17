/**
 * cloudquery_aws_sync — manifest only (external execution).
 *
 * The handler lives in the python-plugins sidecar at
 * `services/python-plugins/app/plugins/cloudquery_aws_sync_plugin.py`,
 * which shells out to the `cloudquery` CLI binary installed at
 * `/opt/cloudquery/cloudquery` in the sidecar image. The TS file keeps:
 *
 *   - the manifest (configSchema / outputs / requires{kind:postgres}) so
 *     the Connections + Datasets + Pipeline-Builder UIs render a real
 *     form and the spec validator catches binding-kind mismatches at
 *     /validate without a round-trip,
 *   - the default route-table tables (`aws_ec2_route_tables`,
 *     `aws_ec2_routes`) plus the allowlist of additive tables the
 *     operator can opt into — kept in sync with the Python sidecar's
 *     allowlist so the dropdown stays accurate when one side gains a
 *     table the other hasn't yet.
 *
 * Why external: cloudquery is a Go binary, not a Node module. Bundling
 * it (or even bundling a wrapper that depends on its Go deps) would
 * inflate the worker image and pull Go-specific surface into the Node
 * runtime — exactly what the transport split in `plugin-sdk/transport`
 * exists to prevent. Lives in the sidecar where the binary is
 * installed; the Node worker stays lean. Same pattern as cartography.
 *
 * Seam discipline (NON-NEGOTIABLE):
 *   bulwark AUTHORS pipeline definitions and drives RAGdoll's API.
 *   RAGdoll NEVER computes resolution or correlation. cloudquery is
 *   just a TRANSPORT RAGdoll learns to speak — this plugin runs a
 *   scoped `cloudquery sync` (AWS source → Postgres destination) and
 *   reports per-table row counts. The mapping from `aws_ec2_route_tables`
 *   rows to canonical RouteTable nodes is bulwark's adapter (Z4); the
 *   multi-source merge that drives "Route exists?" is bulwark's Z6.
 *   This plugin does NOTHING with the rows it lands — they're cloudquery's
 *   native Postgres sink shape, bulwark reads them back from Postgres
 *   directly.
 *
 * Registration: handled by the plugin-loader's `registerExternalPlugins()`
 * pass — pointed at `process.env.PYTHON_PLUGIN_URL`. With that env var
 * unset, cloudquery_aws_sync simply isn't registered (matches the existing
 * behaviour for cartography_crawl / crawl4ai_crawler / scrapy_spider).
 */

import type { PluginManifest } from "../../../packages/plugin-sdk/src/index.ts";

/**
 * Default scope when the operator doesn't override `config.tables` —
 * the route-table tables Z6a needs to land. Additive: an operator can
 * include any table from {@link CLOUDQUERY_AWS_ALLOWED_TABLES} without
 * a code change. Kept in sync with the Python sidecar handler's
 * allowlist (a mismatch where the TS dropdown advertises a table the
 * sidecar refuses is exactly the kind of split-source-of-truth bug
 * cartography's parallel allowlist comment warns about).
 */
export const CLOUDQUERY_AWS_DEFAULT_TABLES = [
  "aws_ec2_route_tables",
  "aws_ec2_routes"
] as const;

/**
 * Tables this plugin will ALLOW the operator to add via `config.tables`.
 * Constrained to the network / exposure surface bulwark consumes in Z6:
 * route tables, the network primitives they reference (VPC / subnet /
 * NAT / IGW / TGW), and the load-balancers the WAF / public-reachability
 * scenarios join against. Adding a wholly new shape (e.g. IAM rows)
 * belongs in a sibling plugin, not in this one's scope — the seam
 * discipline §"Out of scope" of ADR-0033 covers why.
 *
 * If you add a table here, also add it to
 * `services/python-plugins/app/plugins/cloudquery_aws_sync_plugin.py:CLOUDQUERY_AWS_ALLOWED_TABLES`.
 */
export const CLOUDQUERY_AWS_ALLOWED_TABLES = [
  // Route tables — the Z6a headline scope.
  "aws_ec2_route_tables",
  "aws_ec2_routes",
  // Network primitives — the canonical IDs route tables reference.
  "aws_ec2_vpcs",
  "aws_ec2_subnets",
  "aws_ec2_internet_gateways",
  "aws_ec2_nat_gateways",
  "aws_ec2_transit_gateways",
  "aws_ec2_transit_gateway_attachments",
  "aws_ec2_vpc_peering_connections",
  "aws_ec2_vpc_endpoints",
  // Load balancers + their listeners — the exposure dimension Z6
  // joins against route tables (target group IDs ↔ subnets).
  "aws_elbv2_load_balancers",
  "aws_elbv2_target_groups",
  "aws_elbv2_listeners"
] as const;

export type CloudQueryAwsTable = (typeof CLOUDQUERY_AWS_ALLOWED_TABLES)[number];

/** cloudquery sync write modes. `overwrite` is the safest default for
 *  evidence pulls — each sync replaces the prior snapshot; bulwark
 *  reads the latest. Append modes are for operators who want a history
 *  on the cloudquery side. */
export const CLOUDQUERY_WRITE_MODES = [
  "overwrite",
  "append",
  "overwrite-delete-stale"
] as const;
export type CloudQueryWriteMode = (typeof CLOUDQUERY_WRITE_MODES)[number];

/** Plugin-source-resolution registries the OSS path supports.
 *
 *   - `local`      — Default. Plugin binary lives on the sidecar FS
 *                    (`/opt/cq-plugins/source-aws` /
 *                    `/opt/cq-plugins/destination-postgresql` from
 *                    the Dockerfile). cloudquery exec()s it. No
 *                    auth, no network.
 *   - `grpc`       — Plugin runs out-of-band; `path` is the gRPC
 *                    address. Useful for operators running plugins
 *                    in a separate container they control.
 *   - `docker`     — cloudquery `docker pull` + `docker run`s the
 *                    image. Requires docker socket access on the
 *                    sidecar (NOT enabled by default in our
 *                    compose stack).
 *   - `cloudquery` — Hub default. Requires `cloudquery login` /
 *                    CLOUDQUERY_API_KEY EVEN FOR OSS PLUGINS as
 *                    of late 2025. Avoid in production paths;
 *                    listed here for completeness so the Builder
 *                    UI can surface it for operators with Hub
 *                    accounts.
 *
 * Default is `local` — the OSS-without-auth path is the one
 * operators get without any extra configuration. See ADR-0033
 * §"Amendment — OSS plugin source via registry: local."
 */
export const CLOUDQUERY_PLUGIN_REGISTRIES = [
  "local",
  "grpc",
  "docker",
  "cloudquery"
] as const;
export type CloudQueryPluginRegistry =
  (typeof CLOUDQUERY_PLUGIN_REGISTRIES)[number];

export const cloudqueryAwsSyncManifest: PluginManifest = {
  id: "cloudquery_aws_sync",
  name: "CloudQuery AWS Sync",
  version: "1.0.0",
  category: "datasource",
  contract: 2,
  // ADR-0023 binding shape — `destination` resolves to the Postgres
  // connection cloudquery's native sink writes to. Per the
  // PluginManifest.requires contract: a plugin that declares `requires`
  // MUST NOT also expose host/port/URL in its `configSchema` — the
  // dataset connection is the single source of truth.
  // Cast through unknown — PluginManifest.requires is still typed
  // against the legacy `{modality, provider}` shape for back-compat
  // even though the validator + worker both accept the ADR-0023
  // `{binding, kind|kindOneOf}` form below. Same trick used by
  // neo4j_query / neo4j_write / cartography_crawl.
  requires: [
    { binding: "destination", kind: "postgres" }
  ] as unknown as PluginManifest["requires"],
  description:
    "Runs a scoped `cloudquery sync` (CloudQuery's AWS source plugin → Postgres destination plugin) and lands the rows in the Postgres connection bound to this node's `destination` binding. Default scope is the route-table tables (`aws_ec2_route_tables`, `aws_ec2_routes`); additive tables come from the same network/exposure surface bulwark consumes (VPC, subnet, gateway, ELBv2 — see `CLOUDQUERY_AWS_ALLOWED_TABLES`).\n\n## Plugin source: OSS / no Hub login (the default)\n\nThe AWS source + PostgreSQL destination plugins are sourced via `registry: local` by default — the OSS path, no `cloudquery login` / CLOUDQUERY_API_KEY required. The plugin binaries ship inside the python-plugins sidecar image at `/opt/cq-plugins/source-aws` and `/opt/cq-plugins/destination-postgresql` (versions pinned in the Dockerfile). cloudquery exec()s them directly. Operators with a private mirror can override via `config.awsPluginPath` / `config.pgPluginPath`; operators with a Hub account can switch `config.registry` to `cloudquery`. See ADR-0033 §Amendment for why the default moved off the Hub.\n\n## Seam discipline (READ THIS FIRST)\n\nbulwark AUTHORS the pipeline that uses this plugin; bulwark owns the canonical mapping (`aws_ec2_route_tables` rows → RouteTable nodes — Z4 adapter) and the multi-source merge (`Route exists?` — Z6). **RAGdoll PULLS only.** This plugin reports row counts per table and otherwise has no opinion about what those rows mean. If you find yourself reaching for resolution / canonical-node logic inside this plugin, that's the seam being crossed — push it back to bulwark.\n\n## Wiring AWS credentials\n\nCloud credentials require TWO things on the spec node — `config.credsSecretRef` alone is not enough (same gotcha as cartography_crawl):\n\n```jsonc\n{\n  \"id\": \"cq-sync\",\n  \"plugin\": { \"category\": \"datasource\", \"id\": \"cloudquery_aws_sync\", \"version\": \"1.0.0\" },\n  \"dataset\": { \"slug\": \"<dataset whose `destination` binding points at a kind=postgres connection>\" },\n  \"config\": {\n    \"tables\": [\"aws_ec2_route_tables\", \"aws_ec2_routes\"],\n    \"regions\": [\"us-east-1\"],\n    \"accountId\": \"123456789012\",\n    \"credsSecretRef\": \"aws-prod\"\n  },\n  \"secrets\": {\n    \"aws-prod\": { \"scope\": \"tenant\", \"key\": \"AWS_PROD_CREDS\" }\n  }\n}\n```\n\nThe credsSecretRef value is a `.env`-style block (one `KEY=VALUE` per line — `AWS_ACCESS_KEY_ID=...`, `AWS_SECRET_ACCESS_KEY=...`, optional `AWS_SESSION_TOKEN=...`, optional `AWS_DEFAULT_REGION=...`). The sidecar exports each line into cloudquery's subprocess env; raw values never appear in argv, the trace, or the logs.\n\n## What lands where\n\ncloudquery's Postgres destination plugin owns the destination DDL: it CREATEs the tables (`aws_ec2_route_tables`, `aws_ec2_routes`, etc.) and writes rows into them with cloudquery's native column shape (snake_case, `_cq_id` / `_cq_sync_time` provenance columns, etc.). bulwark reads from THESE TABLES verbatim — RAGdoll does NOT remap them. A bulwark schema bump that adds a column maps to a CloudQuery version bump that exposes that column in `_source`, not to a code change here.",
  configSchema: {
    type: "object",
    required: ["tables"],
    properties: {
      tables: {
        type: "array",
        items: {
          type: "string",
          enum: [...CLOUDQUERY_AWS_ALLOWED_TABLES]
        },
        default: [...CLOUDQUERY_AWS_DEFAULT_TABLES],
        description:
          "CloudQuery tables to sync. Defaults to the route-table set (`aws_ec2_route_tables`, `aws_ec2_routes`). Additive — restricted to the network / exposure surface bulwark consumes in Z6 (see `CLOUDQUERY_AWS_ALLOWED_TABLES`); other shapes belong in sibling plugins."
      },
      regions: {
        type: "array",
        items: { type: "string" },
        description:
          "AWS regions to scope the sync to. When omitted, cloudquery's AWS source plugin uses its own default (all enabled regions for the account); supplying an explicit list keeps the sync fast and the row counts deterministic."
      },
      accountId: {
        type: "string",
        description:
          "AWS account id to scope the sync to. Belt-and-braces with the credsSecretRef — when set, cloudquery writes the row's `account_id` column with this value AND fails loudly if the resolved creds belong to a different account. Omit for multi-account credsets (cloudquery iterates whichever accounts the creds can assume into)."
      },
      writeMode: {
        type: "string",
        enum: [...CLOUDQUERY_WRITE_MODES],
        default: "overwrite",
        description:
          "How cloudquery's Postgres destination handles existing rows. `overwrite` (default): each sync REPLACES the prior snapshot — safest for evidence pulls. `append`: rows accumulate (operator owns retention). `overwrite-delete-stale`: overwrite + drop rows the new snapshot didn't include (cloudquery's `overwrite-delete-stale` write mode)."
      },
      registry: {
        type: "string",
        enum: [...CLOUDQUERY_PLUGIN_REGISTRIES],
        default: "local",
        description:
          "How cloudquery resolves the AWS source + Postgres destination plugins. Defaults to `local` — the OSS path, no CloudQuery Hub login required (the plugin binaries ship inside the python-plugins sidecar image; cloudquery exec()s them). Switch to `grpc` to point at out-of-band plugin processes, `docker` if the sidecar gets docker socket access, or `cloudquery` to use the Hub registry (which requires `cloudquery login` / CLOUDQUERY_API_KEY EVEN FOR OSS PLUGINS). See ADR-0033 §Amendment for the rationale."
      },
      awsPluginPath: {
        type: "string",
        description:
          "Override for the AWS source plugin location. Meaning depends on `registry`: a filesystem path for `local`, a gRPC address (`host:port`) for `grpc`, a docker image reference for `docker`, a Hub plugin path (`cloudquery/aws`) for `cloudquery`. Defaults: `/opt/cq-plugins/source-aws` for `local`. Only set when pointing at a private mirror or a custom build."
      },
      pgPluginPath: {
        type: "string",
        description:
          "Override for the PostgreSQL destination plugin location — same semantics as `awsPluginPath`. Defaults: `/opt/cq-plugins/destination-postgresql` for `local`."
      },
      awsPluginVersion: {
        type: "string",
        description:
          "Version label for the AWS source plugin (informational on `registry: local`; used for image tag / Hub lookup on `docker` / `cloudquery`). Defaults to the version of the binary baked into the sidecar image."
      },
      pgPluginVersion: {
        type: "string",
        description:
          "Version label for the PostgreSQL destination plugin — same semantics as `awsPluginVersion`."
      },
      cloudqueryBin: {
        type: "string",
        default: "/opt/cloudquery/cloudquery",
        description:
          "Path to the cloudquery CLI binary inside the python-plugins sidecar. Defaults to the install location the sidecar Dockerfile creates. Override only when the operator installed cloudquery elsewhere."
      },
      timeoutMs: {
        type: "integer",
        default: 1_800_000,
        description: "Per-sync wall-clock timeout (ms). Default 30 minutes."
      },
      runner: {
        type: "string",
        enum: ["subprocess", "dry-run"],
        default: "subprocess",
        description:
          "Execution mode. `subprocess` shells out to the cloudquery CLI; `dry-run` returns synthetic metadata for the Builder's unbound preview + tests."
      },
      credsSecretRef: {
        type: "string",
        format: "secret-ref",
        description:
          "Logical name the plugin looks up in `input.secrets` to get AWS credentials. IMPORTANT: this field alone is NOT enough — the spec node must ALSO declare `node.secrets: { <this-name>: <secret-ref> }` so the runtime's SecretProvider actually resolves the value. The secret value is a `.env`-style block (one `KEY=VALUE` per line, e.g. `AWS_ACCESS_KEY_ID=...` / `AWS_SECRET_ACCESS_KEY=...` / optional `AWS_SESSION_TOKEN=...`). Raw values never appear in argv, the execution trace, or the logs."
      }
    },
    additionalProperties: false
  },
  secretsSchema: {
    type: "object",
    properties: {
      creds: {
        type: "string",
        format: "secret-ref",
        description: "Alias for credsSecretRef."
      }
    },
    additionalProperties: false
  },
  inputPorts: [],
  outputPorts: [
    {
      name: "metadata",
      description:
        "Sync run envelope: { syncId, startedAt, completedAt, mode, target: { connectionSlug, database }, tables: [{ table, rowsSynced, rowsDeleted?, error? }], totalRowsSynced, exitCode? }. Per-table row counts come from cloudquery's structured stdout (`Resource counts: ...`); rowsDeleted is populated only when writeMode includes `delete-stale`. Pure transport telemetry — bulwark reads the actual rows back from Postgres."
    }
  ],
  // Stream cloudquery's stderr line-by-line through the runtime's onToken
  // sink so operators see the sync progressing on the trace UI instead
  // of a 30-minute spinner. The handler still returns the full envelope
  // on completion — streaming is additive, not the only delivery shape.
  streaming: true,
  capabilities: ["ingestion"],
  ui: {
    icon: "cloud-download",
    color: "#16a34a",
    paletteGroup: "Sources",
    formHints: {
      tables: { widget: "tags" },
      regions: { widget: "tags" },
      writeMode: { widget: "select" },
      registry: { widget: "select" },
      runner: { widget: "select" },
      timeoutMs: { widget: "number", min: 60_000, step: 60_000 }
    }
  }
};
