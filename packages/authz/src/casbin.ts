/**
 * Real Casbin policy engine.
 *
 * `casbin` is imported lazily (like bullmq/pg elsewhere) so the install-free
 * `node --test` runner — which never touches this file — keeps working with an
 * empty node_modules. The Docker images run `npm install`, so the server uses
 * this engine; everything else falls back to {@link BuiltinPolicyEngine}.
 *
 * The model lives in {@link CASBIN_MODEL}. Grants are `g` policies whose third
 * field is the hierarchical scope (the Casbin "domain"); {@link scopeCovers} is
 * registered as the named domain-matching function so an ancestor-scope grant
 * authorizes descendant-scope requests. A `BuiltinPolicyEngine`-equivalent
 * decision is guaranteed by `test/casbin-conformance.test.ts`.
 */
import {
  CASBIN_MODEL,
  scopeCovers,
  type Grant,
  type PolicyEngine,
  type RoleCatalog,
  type ScopedDecider
} from "./index.ts";

/**
 * Structural view of the slice of `casbin` we use. Declared locally (mirroring
 * the worker's bullmq pattern) so this file type-checks and edits cleanly
 * without `casbin` installed; the real module is loaded via `await import`.
 */
interface CasbinEnforcer {
  addNamedDomainMatchingFunc(
    ptype: string,
    fn: (d1: string, d2: string) => boolean
  ): void;
  buildRoleLinks(): Promise<void>;
  enforceSync(...args: unknown[]): boolean;
}
interface CasbinModule {
  newModelFromString(text: string): unknown;
  StringAdapter: new (policy: string) => unknown;
  newEnforcer(model: unknown, adapter: unknown): Promise<CasbinEnforcer>;
}

/** Escape a Casbin CSV field (comma / quote / newline safe). */
function csv(field: string): string {
  if (/[",\n]/.test(field)) return `"${field.replace(/"/g, '""')}"`;
  return field;
}

export class CasbinPolicyEngine implements PolicyEngine {
  // Loaded lazily and memoised across requests.
  private mod: CasbinModule | undefined;

  private async casbin(): Promise<CasbinModule> {
    if (!this.mod) {
      this.mod = (await import("casbin" as string)) as unknown as CasbinModule;
    }
    return this.mod;
  }

  async prepare(
    grants: Grant[],
    catalog: RoleCatalog
  ): Promise<ScopedDecider> {
    const casbin = await this.casbin();
    const model = casbin.newModelFromString(CASBIN_MODEL);

    // One synthetic subject; its `g` edges are exactly this principal's grants.
    const SUB = "principal";
    const lines: string[] = [];
    for (const [role, perms] of catalog) {
      for (const perm of perms) {
        lines.push(`p, ${csv(role)}, ${csv(perm)}`);
      }
    }
    for (const g of grants) {
      lines.push(`g, ${SUB}, ${csv(g.role)}, ${csv(g.scope)}`);
    }

    // With no catalog AND no grants there is nothing that could ever match —
    // that is exactly default-deny. Casbin's StringAdapter also rejects an
    // empty policy document ("cannot be false-y"), so short-circuit instead of
    // constructing an enforcer over an empty string.
    if (lines.length === 0) return () => false;

    const adapter = new casbin.StringAdapter(lines.join("\n"));
    const enforcer = await casbin.newEnforcer(model, adapter);
    // The domain-matching function makes `g(sub, role, requestScope)` true when
    // a grant exists at any scope that *covers* requestScope. Casbin invokes it
    // as fn(requestDomain, policyDomain).
    enforcer.addNamedDomainMatchingFunc(
      "g",
      (requestScope: string, grantScope: string) =>
        scopeCovers(grantScope, requestScope)
    );
    await enforcer.buildRoleLinks();

    return (permission: string, requestScope: string): boolean =>
      enforcer.enforceSync(SUB, requestScope, permission);
  }
}

/** Factory used by the server; resolves only if `casbin` is importable. */
export async function createCasbinEngine(): Promise<CasbinPolicyEngine> {
  const engine = new CasbinPolicyEngine();
  // Fail fast at bootstrap rather than on the first request. Probe with a
  // real (non-empty) policy so this genuinely validates that `casbin` loads,
  // the model compiles, the domain matcher binds, and enforceSync works.
  const probeCatalog: RoleCatalog = new Map([
    ["__probe__", new Set(["__probe__"])]
  ]);
  const decide = await engine.prepare(
    [{ role: "__probe__", scope: "*" }],
    probeCatalog
  );
  if (decide("__probe__", "*") !== true) {
    throw new Error("casbin probe failed: unexpected decision");
  }
  return engine;
}
