# ADR 0008: Plugin Config & Secrets UX (Schema-Driven Forms + Optional Custom Editor)

## Status

Accepted

## Context

Pipeline nodes carry per-plugin `config` (non-secret) and `secrets` (secret
references). Until now the web UI rendered these as raw JSON textareas: error
prone, undiscoverable, and unsafe for secrets (operators pasted raw key
material into a free-text field). Plugin manifests already had optional
`configSchema`/`secretsSchema`/`ui` fields, but the built-in plugins did not
populate them and the control plane did not expose them, so the UI had nothing
to render a real form from.

We need three things: (1) plugins to describe their config/secrets shape, (2)
the control plane to expose that description, and (3) a UX that renders a real
form by default while leaving room for a small number of plugins that genuinely
need a bespoke editor — without adopting a heavyweight micro-frontend runtime.

## Decision

**Schema-driven forms by default.** Every in-process plugin declares a real
`configSchema` (and `secretsSchema` where it reads secrets) using the
dependency-free `JsonSchemaLike` subset in `@ragdoll/plugin-sdk`. The subset is
extended minimally with `enum`, `default`, and `format` (no JSON-Schema
library). Manifests also carry `ui.formHints` (e.g. a `range` widget for
`temperature`, a `secret` widget for `apiKey`) so the renderer can pick good
controls. The schema must reflect exactly what the plugin's `execute` reads
from `config`/`secrets`; runtime behavior is unchanged. `GET /api/plugins` and
`GET /api/plugins/:category/:id/:version` project these manifest fields so the
UI builds the form from server data and never hardcodes plugin knowledge.

**Visual, structured secrets — metadata only.** Secret fields are modeled with
`format: "secret-ref"`. The UI renders a secret picker bound to the existing
secrets API; only the *reference* (key/scope), never raw secret material,
travels in plugin config. Secret values continue to be stored and resolved
server-side; they never leave the server through the plugin config surface.

**Optional sandboxed custom plugin UI (Tier-2 seam, contract only).** A plugin
manifest may set `ui.module`: an ESM module URL the web app can dynamically
import to render a bespoke config editor. The module default-exports (or
exports a named `ConfigEditor`) a React component
`(props: { value: Record<string, unknown>; schema?: JsonSchemaLike;
onChange: (next: Record<string, unknown>) => void }) => ReactNode`. `value` is
the controlled non-secret config; `onChange` emits the full next config object;
`schema` is the plugin's `configSchema` for reference. Secret values are never
passed to or returned from a custom editor — it may only emit secret
references. This ADR ships only the typed seam in `@ragdoll/plugin-sdk` and the
contract documentation; no host loader is implemented here. Because a custom
editor is untrusted third-party code, hosts MUST treat `ui.module` as
admin-only / explicitly registered and load it sandboxed (isolated origin /
restrictive CSP), defaulting to the schema-driven form when absent or not
trusted.

**Explicitly NOT adopting single-spa / Module Federation now.** The web app is
a static SPA with a small, fixed shared-dependency surface. A general
micro-frontend runtime (single-spa, Webpack/Vite Module Federation) would add a
shared-dependency contract, build-time coupling, and a large security surface
(arbitrary federated remotes) for a feature that, today, no built-in plugin
needs. The `ui.module` + `ConfigEditor` contract is the minimal seam that
covers the real requirement (one component, props in / config out) without that
machinery. Revisit if there is concrete demand for richer cross-plugin UI
composition or third-party plugin marketplaces.

## Consequences

- The UI renders real, validated forms (selects, ranges, number inputs, secret
  pickers) for every built-in plugin instead of JSON textareas.
- Secret material never enters plugin config; only references do, preserving the
  ADR 0003 secret-reference model end to end.
- The shared `GET /api/plugins[/:category/:id/:version]` contract is the single
  source of truth; the web teammate codes to it with no plugin-specific code.
- `JsonSchemaLike` stays dependency-free; no JSON-Schema runtime is added and
  the offline zero-install test invariant is preserved.
- The `ui.module` seam exists as a typed contract today but has no runtime host;
  enabling it later requires an admin-gated, sandboxed loader and a registry of
  trusted modules. Until then it is inert and safe.
- Declining single-spa/Module Federation keeps the build simple and the
  security surface small; the cost is no cross-plugin UI composition, which is
  acceptable until real demand appears.
