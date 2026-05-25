/**
 * `ragdoll keys list / mint / revoke` — self-service API key management.
 *
 * Keys live under the signed-in user; `mint` returns the plaintext exactly
 * once and the CLI writes it to stdout so the operator can stash it (the
 * server cannot show it again). All commands hit the same REST surface
 * the web UI uses; RBAC enforcement is on the API side.
 *
 * Phase 3 of the dataset/RBAC/retrieval refactor: --env scopes the key
 * to a single tenant environment, and --expires accepts either an
 * absolute ISO timestamp or a duration suffix (`7d`, `12h`, `30m`).
 * Both flags are optional; omitting them yields a tenant-wide
 * non-expiring key (the legacy behaviour).
 */
import type { Command } from "commander";
import { api, emit, fail, type Ctx } from "../ctx.ts";

/** Parse `90d` / `12h` / `45m` / `3600s` into an ISO timestamp relative
 *  to now. An absolute ISO string passes through unchanged. */
function resolveExpiresAt(raw: string): string {
  const m = /^(\d+)\s*([dhms])$/i.exec(raw.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms =
      unit === "d"
        ? n * 86_400_000
        : unit === "h"
          ? n * 3_600_000
          : unit === "m"
            ? n * 60_000
            : n * 1000;
    return new Date(Date.now() + ms).toISOString();
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `--expires must be a duration like "7d" or an ISO timestamp; got: ${raw}`
    );
  }
  return parsed.toISOString();
}

export function registerKeys(program: Command, ctx: Ctx): void {
  const keys = program.command("keys").description("Manage your API keys");

  keys
    .command("list")
    .description("List API keys minted by the current user")
    .action(async () => {
      try {
        emit(ctx, await api(ctx, "GET", "/api/api-keys"));
      } catch (e) {
        fail(e, "keys list");
      }
    });

  keys
    .command("mint")
    .description("Mint a new API key (plaintext shown ONCE — save it)")
    .requiredOption("--name <name>", "human label for the key")
    .requiredOption("--role <role>", "role the key carries (must not exceed your authority)")
    .option("--tenant <uuid>", "tenant scope; omit for platform-wide key (if your grants allow)")
    .option(
      "--env <name>",
      "environment scope within the tenant; key cannot act outside this env"
    )
    .option(
      "--expires <when>",
      'expiration as duration ("7d", "12h") or ISO timestamp; omit for no expiration'
    )
    .action(
      async (o: {
        name: string;
        role: string;
        tenant?: string;
        env?: string;
        expires?: string;
      }) => {
        try {
          const body: Record<string, unknown> = {
            name: o.name,
            role: o.role
          };
          if (o.tenant) body.tenantId = o.tenant;
          if (o.env) body.environmentId = o.env;
          if (o.expires) body.expiresAt = resolveExpiresAt(o.expires);
          const res = await api<{
            apiKey: Record<string, unknown>;
            plaintext: string;
          }>(ctx, "POST", "/api/api-keys", { body });
          // emit() formats per `-o json|table|yaml`; we always surface the
          // plaintext alongside the metadata so the operator never misses it.
          emit(ctx, res);
        } catch (e) {
          fail(e, "keys mint");
        }
      }
    );

  keys
    .command("revoke <id>")
    .description("Revoke an API key by its id (irreversible)")
    .action(async (id: string) => {
      try {
        await api(ctx, "DELETE", `/api/api-keys/${id}`);
        emit(ctx, { ok: true, id });
      } catch (e) {
        fail(e, "keys revoke");
      }
    });
}
