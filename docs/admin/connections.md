# Datasource connections

A **connection** is the per-tenant (and optional per-environment) record carrying the host, port and credentials for a backing store — OpenSearch, Qdrant, Dgraph, Postgres, Redis. **Datasets reference connections by `name`**; plugins resolve the live connection through the dataset's backend block at runtime. As a result plugin code never knows the hostname or secret, and a single pipeline spec runs unmodified across dev / qa / prod and across tenants with totally different infrastructure.

This doc covers the data model + cascade semantics. The flow operators use day-to-day is the **Connections** screen in the web UI.

## Model

```
┌──────────────────────┐      ┌──────────────────────┐      ┌──────────────────┐
│ datasource_          │      │ datasets             │      │ Pipeline node    │
│   connections        │◀─────│   .backends.<mod>    │◀─────│   { plugin,      │
│ (tenant, env?, name) │   ┌──│     .connectionName  │      │     dataset:     │
│   host/port/secret   │   │  │     .index/coll/…    │      │       {slug,     │
└──────────────────────┘   │  └──────────────────────┘      │        alias} }  │
                           │                                 └──────────────────┘
                           │ resolved per (tenant, env)
                           ▼
                resolver chooses the connection
                  the plugin will actually use
```

The chart below explains the **cascade** the resolver follows when a dataset asks "give me connection `os-main` for tenant A in environment `prod`":

```
1. row WHERE tenant_id = 'A' AND environment_id = 'prod' AND name = 'os-main'  → use this
2. else row WHERE tenant_id = 'A' AND environment_id IS NULL AND name = 'os-main' → use this (tenant-wide fallback)
3. else → resolver returns null, plugin reports "missing connection"
```

So a single tenant-wide row applies to every env until an operator deliberately splits one env off.

## Example

**Tenant A** runs a single OpenSearch cluster shared across dev / prod (admin creds, per-env index):

```sql
-- one connection that applies to every env in tenant A
name = 'os'
tenant_id = A
environment_id = NULL          -- tenant-wide
datasource_type = 'opensearch'
config_redacted = { "host": "os.tenantA.example", "port": 9200 }
secret_ref_id = → admin/admin
```

**Tenant B** has three OpenSearch clusters (one per env, no auth):

```sql
name = 'os', tenant_id = B, environment_id = 'dev',  config = { "host": "os-dev.tenantB.example",  "port": 9200 }
name = 'os', tenant_id = B, environment_id = 'qa',   config = { "host": "os-qa.tenantB.example",   "port": 9200 }
name = 'os', tenant_id = B, environment_id = 'prod', config = { "host": "os-prod.tenantB.example", "port": 9200 }
```

A pipeline can pin `dataset: {slug: my-docs, alias: stable}` for both tenants — the resolver picks the right host automatically because tenant B has env-specific rows and tenant A's tenant-wide row applies.

## CRUD

Via UI (Connections screen) or HTTP:

| Verb   | Path                                | Notes                                                   |
| ------ | ----------------------------------- | ------------------------------------------------------- |
| GET    | `/api/connections`                  | requires `x-tenant-id`; optional `?environmentId=X` dedupes by name and surfaces what the cascade would pick |
| GET    | `/api/connections/:id`              | single row by id                                        |
| POST   | `/api/connections`                  | `{ name, datasourceType, environmentId?, config, secretRefId? }` |
| PATCH  | `/api/connections/:id`              | partial update                                          |
| DELETE | `/api/connections/:id`              | hard delete                                             |
| GET    | `/api/connections/resolve/:name`    | diagnostic — returns `{ resolved, reason }` where reason is `env_specific`, `tenant_fallback`, or `no_match` |

The list endpoint's `?environmentId=` filter is the same view the UI shows: with an env selected, two connection rows named `os` collapse to whichever the cascade picks. Without an env, every row is listed.

### `datasourceType` allowed values

`opensearch`, `qdrant`, `dgraph`, `pgvector`, `postgres`, `redis`. Adding a new one means adding a backend in the cascade + a plugin that knows how to consume it.

### Secret handling

`secretRefId` points at a row in `secret_refs` (the same table the plugins'
`secrets:` block uses). The connection row itself never stores plaintext — the
secret resolves via `DatabaseEncryptedSecretProvider` at runtime, scoped by the
calling tenant. The `secret_refs` table already supports env-scoping, so a
single connection can pair with an env-specific secret if you want different
credentials per env without splitting the connection.

## Future cross-refs (PR4)

* Dataset detail → "resolved connection for current tenant/env: `os` → `os-prod.tenantB.example:9200` (env_specific)"
* Connection detail → "datasets pinning this connection name"
* Builder node → "this plugin's `dataset` resolves to dataset X → connection Y in env E"

Wired in PR4.
