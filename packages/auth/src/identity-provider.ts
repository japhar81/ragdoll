/**
 * Identity-provider SPI — the swappable seam for authentication + SSO.
 *
 * Historically `apps/api/src/app.ts` hard-coded `if (kind === "oidc") new
 * OidcProvider(...) else new SamlProvider(...)`, and the SSO routes branched
 * on `instanceof OidcProvider`. That coupling is replaced by:
 *
 *   - {@link SsoProviderInstance} — a uniform live handler for one configured
 *     IdP row (`start` → redirect URL, `callback` → external identity), so the
 *     routes never branch on the protocol.
 *   - {@link IdentityProvider} — the pluggable SPI: declares which
 *     `identity_providers.kind` value(s) it serves and builds an
 *     `SsoProviderInstance` from a row's config.
 *   - {@link IdentityProviderRegistry} — kind → provider lookup.
 *
 * The built-in OIDC + SAML behaviour is preserved exactly, now registered as
 * the default providers ({@link defaultIdentityProviderRegistry}). A custom
 * identity provider from an external repo is loaded at boot via
 * {@link loadIdentityProviderModule} (RAGDOLL_IDENTITY_PROVIDER) and can ADD a
 * new kind (e.g. "ldap") or OVERRIDE oidc/saml. See ADR 0035.
 */

import type { SsoIdentity } from "./oidc.ts";
import { OidcProvider } from "./oidc.ts";
import { SamlProvider } from "./saml.ts";

export type { SsoIdentity } from "./oidc.ts";

/** The protocol-agnostic input a provider builds from — the relevant slice of
 *  an `identity_providers` row, without coupling the auth package to the DB
 *  row type. */
export interface IdentityProviderInput {
  kind: string;
  config: Record<string, unknown>;
}

/** A live SSO handler for one configured IdP row. Uniform across protocols so
 *  the routes call the same two methods regardless of OIDC/SAML/custom. */
export interface SsoProviderInstance {
  /** Build the IdP redirect URL that begins login. `nonce` is OIDC-only; a
   *  SAML (or other) implementation may ignore it and use `state`. */
  start(args: {
    redirectUri: string;
    state: string;
    nonce: string;
  }): Promise<string>;
  /** Complete login from the IdP callback → the external identity. OIDC reads
   *  `code` + `redirectUri` + `expectedNonce`; SAML reads `samlResponse`. A
   *  provider takes what it needs and throws if a required field is absent. */
  callback(args: {
    code?: string;
    redirectUri: string;
    expectedNonce: string;
    samlResponse?: string;
  }): Promise<SsoIdentity>;
}

/** The pluggable identity-provider SPI. */
export interface IdentityProvider {
  /** The `identity_providers.kind` value(s) this provider serves. */
  readonly kinds: readonly string[];
  /** Construct a live SSO handler for one configured IdP row. */
  build(input: IdentityProviderInput): SsoProviderInstance;
}

/** kind → provider lookup. Later registrations for the same kind win, which is
 *  what lets a custom module override a built-in. */
export class IdentityProviderRegistry {
  private byKind = new Map<string, IdentityProvider>();

  register(provider: IdentityProvider): void {
    for (const kind of provider.kinds) this.byKind.set(kind, provider);
  }

  resolve(kind: string): IdentityProvider | undefined {
    return this.byKind.get(kind);
  }

  /** Build a live handler for a configured row; throws on an unknown kind. */
  build(input: IdentityProviderInput): SsoProviderInstance {
    const provider = this.byKind.get(input.kind);
    if (!provider) {
      throw new Error(
        `no identity provider registered for kind "${input.kind}" (have: ${this.kinds().join(", ") || "none"})`
      );
    }
    return provider.build(input);
  }

  kinds(): string[] {
    return [...this.byKind.keys()];
  }
}

/** Built-in OIDC provider — wraps {@link OidcProvider} unchanged. */
export const oidcIdentityProvider: IdentityProvider = {
  kinds: ["oidc"],
  build({ config: c }) {
    const provider = new OidcProvider({
      issuer: String(c.issuer ?? ""),
      clientId: String(c.clientId ?? ""),
      clientSecret: String(c.clientSecret ?? ""),
      scopes: typeof c.scopes === "string" ? c.scopes : undefined
    });
    return {
      start: async ({ redirectUri, state, nonce }) =>
        provider.authorizationUrl({ redirectUri, state, nonce }),
      callback: async ({ code, redirectUri, expectedNonce }) => {
        if (!code) {
          throw new Error("oidc callback requires an authorization code");
        }
        return provider.handleCallback({ code, redirectUri, expectedNonce });
      }
    };
  }
};

/** Built-in SAML provider — wraps {@link SamlProvider} unchanged. */
export const samlIdentityProvider: IdentityProvider = {
  kinds: ["saml"],
  build({ config: c }) {
    const provider = new SamlProvider({
      entryPoint: String(c.entryPoint ?? ""),
      issuer: String(c.issuer ?? ""),
      callbackUrl: String(c.callbackUrl ?? ""),
      idpCert: String(c.idpCert ?? ""),
      emailAttribute:
        typeof c.emailAttribute === "string" ? c.emailAttribute : undefined,
      nameAttribute:
        typeof c.nameAttribute === "string" ? c.nameAttribute : undefined
    });
    return {
      // SAML's RelayState carries the CSRF `state`; nonce is unused.
      start: async ({ state }) => provider.loginRedirectUrl(state),
      callback: async ({ samlResponse }) => {
        if (!samlResponse) {
          throw new Error("saml callback requires a SAMLResponse");
        }
        return provider.validatePostResponse({ SAMLResponse: samlResponse });
      }
    };
  }
};

/** A registry pre-populated with the built-in OIDC + SAML providers — the
 *  default RAGdoll identity stack. */
export function defaultIdentityProviderRegistry(): IdentityProviderRegistry {
  const registry = new IdentityProviderRegistry();
  registry.register(oidcIdentityProvider);
  registry.register(samlIdentityProvider);
  return registry;
}

/** What a custom identity-provider module may default-export. */
export type IdentityProviderModuleExport =
  | IdentityProvider
  | IdentityProvider[]
  | ((registry: IdentityProviderRegistry) => void | Promise<void>);

function isIdentityProvider(v: unknown): v is IdentityProvider {
  return (
    typeof v === "object" &&
    v !== null &&
    Array.isArray((v as IdentityProvider).kinds) &&
    typeof (v as IdentityProvider).build === "function"
  );
}

/** Apply a module's export to the registry: a registrar function is invoked
 *  with the registry; an IdentityProvider (or array) is registered directly. */
export async function applyIdentityProviderExport(
  registry: IdentityProviderRegistry,
  exported: unknown
): Promise<void> {
  if (typeof exported === "function") {
    await (exported as (r: IdentityProviderRegistry) => void | Promise<void>)(
      registry
    );
    return;
  }
  const providers = Array.isArray(exported) ? exported : [exported];
  for (const p of providers) {
    if (!isIdentityProvider(p)) {
      throw new Error(
        "identity provider module export is not an IdentityProvider, IdentityProvider[], or registrar function"
      );
    }
    registry.register(p);
  }
}

/**
 * Load a custom identity-provider module and register/override its providers.
 * `moduleUrl` is a package name or path (RAGDOLL_IDENTITY_PROVIDER); unset →
 * no-op (built-ins only). The module's default export (or the module itself)
 * is an {@link IdentityProviderModuleExport}. `importer` is injectable for
 * tests. Loaded ONCE at boot — these are vetted, security-critical singletons,
 * not runtime-fetched code.
 */
export async function loadIdentityProviderModule(
  registry: IdentityProviderRegistry,
  moduleUrl: string | undefined,
  importer: (spec: string) => Promise<unknown> = (spec) => import(spec)
): Promise<{ loaded: boolean; kinds: string[] }> {
  if (!moduleUrl) return { loaded: false, kinds: registry.kinds() };
  const mod = (await importer(moduleUrl)) as { default?: unknown };
  const exported =
    mod && typeof mod === "object" && "default" in mod ? mod.default : mod;
  await applyIdentityProviderExport(registry, exported);
  return { loaded: true, kinds: registry.kinds() };
}
