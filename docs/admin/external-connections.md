# External Connections — DEPRECATED

> **This page is deprecated.** The `external_connections` table and the
> `/api/external-connections` REST surface this doc described are
> **gone**. Both were folded into the unified Connections registry per
> [ADR 0023](../adr/0023-unified-connections-registry.md) + [ADR 0024](../adr/0024-connection-drivers-as-plugins.md).
>
> Read **[`connections.md`](./connections.md)** for the current contract:
> one `connections` table, `connection:{read,admin,use}` permissions,
> schema-driven Connections form rendered from each loaded
> `ConnectionDriverPlugin`'s manifest, `/api/connection-kinds` for the
> live catalog.

## Migration cheatsheet

| Old (ADR-0021)                                  | New (ADR-0023 / 0024)                                       |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `external_connections` table                    | `connections`                                               |
| `external_connection:read / admin / use`        | `connection:read / admin / use`                             |
| `GET /api/external-connections`                 | `GET /api/connections`                                      |
| `POST /api/external-connections/:id/probe`      | `POST /api/connections/:id/probe`                           |
| `registerConnectionDriver(kind, factory)`       | `defineConnectionDriverPlugin({...})` + export from plugin  |
| `node.connection: { slug }` inline only         | Same shape works; pipeline-level `bindings:` is preferred   |
| Dataset `backends.<modality>.connectionName`    | Dataset `bindings.<name>.connection`                        |

The historical text of this document (the original ADR-0021
walkthrough, plugin-family overview, "Adding a new family" guide, and
backwards-compat notes against the legacy `postgres-core`) is
preserved in git history. Treat the ADR-0023 contract in
[`connections.md`](./connections.md) as authoritative.
