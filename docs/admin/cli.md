# `ragdoll` CLI

A thin command-line client over the REST API. Auth + the selected tenant are
saved in `~/.ragdoll/config.json` (override path with `RAGDOLL_CONFIG`); env
vars `RAGDOLL_API_URL`, `RAGDOLL_TOKEN`, `RAGDOLL_API_KEY`,
`RAGDOLL_TENANT_ID` win over the file so CI never needs to write to disk.

## Install (from the repo)

```bash
npm install
npx @ragdoll/cli --help
# or run the entry directly:
node --experimental-strip-types apps/cli/src/index.ts --help
```

For a real install, point your shell at the package's `bin`:

```bash
npm link --workspace @ragdoll/cli   # global `ragdoll` -> apps/cli/src/index.ts
```

## Global options

| Flag | Purpose |
| --- | --- |
| `-o, --output <json|table|yaml>` | output format (default: `json`) |
| `--api-url <url>` | override `apiUrl` for this invocation |
| `--tenant <uuid>` | override the saved tenant id |

## Authentication

```bash
ragdoll login --email admin@ragdoll.local --password ragdoll-admin
ragdoll login --api-key rgd_xxx_yyy           # static key alternative
ragdoll whoami                                # principal + grants + permissions
ragdoll logout                                # clear local credentials
```

## Common workflows

```bash
# Tenants
ragdoll tenants list
ragdoll tenants use <tenant-uuid>             # pins x-tenant-id for next calls
ragdoll environments list <tenant-uuid>

# Pipelines
ragdoll pipelines list
ragdoll pipelines get <id-or-slug>
ragdoll pipelines versions <id>
ragdoll pipelines save <id> --version 1.0.0 --spec @./spec.json --publish
ragdoll pipelines deploy <id> --version 1.0.0 --environment prod

# Run a pipeline (auth'd, with input)
ragdoll pipelines run <id> --environment prod --input '{"question":"hi"}'
ragdoll pipelines run <id> --input @./input.json

# Webhook triggers
ragdoll pipelines triggers create <id> --name github-push --environment prod
ragdoll pipelines triggers list <id> -o table
ragdoll pipelines triggers delete <triggerId>

# Schedules (cron, croner-backed)
ragdoll schedules create --tenant <uuid> --pipeline <uuid> \
  --environment prod --cron '0 * * * *' --timezone America/New_York
ragdoll schedules list -o table
ragdoll schedules toggle <id> --enabled false
ragdoll schedules delete <id>

# Executions
ragdoll executions list --limit 5 -o table
ragdoll executions trace <executionId>

# Users + grants
ragdoll users list -o table
ragdoll users create --email new@x.io --password secret123
ragdoll users grants add <userId> --role tenant_admin --tenant <uuid>
ragdoll users grants list <userId>

# Roles
ragdoll roles list
ragdoll roles set-permissions viewer --permissions execution:view_logs,pipeline:create

# Identity providers (SSO)
ragdoll identity-providers create \
  --slug okta --kind oidc --display-name Okta \
  --config '{"issuer":"https://example.okta.com","clientId":"abc","clientSecret":"shhh"}'

# Auth settings
ragdoll auth-settings get
ragdoll auth-settings set --mode open_default_role --default-role viewer

# Observability
ragdoll audit --limit 20 -o table
ragdoll usage --tenant <uuid>
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | unexpected error (network, bad JSON) |
| `2` | the API returned a non-2xx; stderr carries `HTTP <status> <code>: <message>` |

## Config file shape

```json
{
  "apiUrl": "http://localhost:3001",
  "token": "eyJhbGciOiJIUzI1...",
  "tenantId": "e3828ae8-...-d43a2667025d"
}
```

Permissions are written with mode `0600`. `apiKey` is mutually exclusive with
`token` (login overwrites whichever was set previously).
