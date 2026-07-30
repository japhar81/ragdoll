# @ragdoll/connection-sdk

The authoring SDK for **RAGdoll connection drivers** — the small, standalone
contract a plugin depends on to teach the platform how to open and pool a
client for an external system (a database, a search engine, an
identity-protected HTTP API…).

It is deliberately **dependency-free**: it carries the driver types, the
`defineConnectionDriverPlugin` helper, the process-wide driver registry, and
the `TokenSource` credential-lifecycle helper — and pulls in none of the
platform runtime (no secret store, no database, no HTTP framework). A plugin
that installs this package inherits nothing but the contract.

## Install

Build it (`npm run build`) and publish it to whatever registry your
organization uses for private packages; consumers then add
`@ragdoll/connection-sdk` to their workspace like any other dependency. The
build emits plain ESM + type declarations to `dist/`.

## Define a driver

```ts
import {
  defineConnectionDriverPlugin,
  type ResolvedExternalConnection
} from "@ragdoll/connection-sdk";

export const myDriver = defineConnectionDriverPlugin({
  kind: "my-service",
  driver: {
    async create(conn: ResolvedExternalConnection) {
      // Build + return a pooled client. Whatever you return is cached by the
      // platform, keyed by connection.id, and handed back on every acquire.
      return new MyClient({ dsn: conn.secret, ...conn.options });
    },
    async dispose(client) {
      await client.close();
    },
    async probe(client) {
      await client.ping(); // used by the periodic health check
    }
  },
  manifest: {
    displayName: "My Service",
    configSchema: { type: "object", properties: { host: { type: "string" } } }
  }
});
```

Export that from your plugin module; the platform discovers it by the same
duck-typed scan it uses for every other plugin.

## Identity-protected services (`TokenSource`)

For a driver whose usable credential is a short-lived token minted from a
stored secret, compose a `TokenSource` inside the client you return — it owns
single-flight minting, proactive refresh with skew, invalidate-on-401, and
per-audience isolation:

```ts
import { TokenSource } from "@ragdoll/connection-sdk";

const tokens = new TokenSource({
  mint: async () => {
    const secret = conn.resolveSecret ? await conn.resolveSecret() : conn.secret;
    const { access_token, expires_in } = await exchange(secret);
    return { token: access_token, expiresAt: Date.now() + expires_in * 1000 };
  }
});
// per request: const t = await tokens.get(); … on 401: tokens.invalidate();
```

`conn.resolveSecret()` re-reads the stored secret so a rotated credential is
picked up without recreating the connection.
