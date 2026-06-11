/** `ragdoll users / roles / identity-providers ...` — access-control surface. */
import type { Command } from "commander";
import { api, emit, fail, type Ctx } from "../ctx.ts";
import { runDelete } from "../cascade.ts";

export function registerAccess(program: Command, ctx: Ctx): void {
  // ---- users ------------------------------------------------------------
  const users = program.command("users").description("Local users");
  users.command("list").action(async () => {
    try {
      emit(ctx, await api(ctx, "GET", "/api/users"));
    } catch (e) {
      fail(e, "users list");
    }
  });
  users
    .command("create")
    .requiredOption("--email <email>")
    .option("--password <pwd>", "omit to create an SSO-only account")
    .option("--display-name <name>")
    .action(
      async (o: { email: string; password?: string; displayName?: string }) => {
        try {
          emit(
            ctx,
            await api(ctx, "POST", "/api/users", {
              body: {
                email: o.email,
                password: o.password,
                displayName: o.displayName
              }
            })
          );
        } catch (e) {
          fail(e, "users create");
        }
      }
    );
  users
    .command("disable <id>")
    .action(async (id: string) => {
      try {
        emit(
          ctx,
          await api(ctx, "PATCH", `/api/users/${id}`, {
            body: { status: "disabled" }
          })
        );
      } catch (e) {
        fail(e, "users disable");
      }
    });
  users
    .command("enable <id>")
    .action(async (id: string) => {
      try {
        emit(
          ctx,
          await api(ctx, "PATCH", `/api/users/${id}`, {
            body: { status: "active" }
          })
        );
      } catch (e) {
        fail(e, "users enable");
      }
    });
  users.command("delete <id>").action(async (id: string) => {
    try {
      await api(ctx, "DELETE", `/api/users/${id}`);
      emit(ctx, { ok: true });
    } catch (e) {
      fail(e, "users delete");
    }
  });

  // ---- grants -----------------------------------------------------------
  const grants = users.command("grants").description("User grants");
  grants.command("list <userId>").action(async (userId: string) => {
    try {
      emit(ctx, await api(ctx, "GET", `/api/users/${userId}/grants`));
    } catch (e) {
      fail(e, "grants list");
    }
  });
  grants
    .command("add <userId>")
    .requiredOption("--role <name>")
    .option("--tenant <uuid>")
    .option("--environment <env>")
    .option("--pipeline <uuid>")
    .option("--scope <string>", "explicit scope (overrides the parts)")
    .action(
      async (
        userId: string,
        o: {
          role: string;
          tenant?: string;
          environment?: string;
          pipeline?: string;
          scope?: string;
        }
      ) => {
        try {
          emit(
            ctx,
            await api(ctx, "POST", `/api/users/${userId}/grants`, {
              body: {
                role: o.role,
                scope: o.scope,
                tenantId: o.tenant,
                environment: o.environment,
                pipelineId: o.pipeline
              }
            })
          );
        } catch (e) {
          fail(e, "grants add");
        }
      }
    );
  grants
    .command("remove <userId> <grantId>")
    .action(async (userId: string, grantId: string) => {
      try {
        await api(ctx, "DELETE", `/api/users/${userId}/grants/${grantId}`);
        emit(ctx, { ok: true });
      } catch (e) {
        fail(e, "grants remove");
      }
    });

  // ---- roles ------------------------------------------------------------
  const roles = program.command("roles").description("Roles and permissions");
  roles.command("list").action(async () => {
    try {
      emit(ctx, await api(ctx, "GET", "/api/roles"));
    } catch (e) {
      fail(e, "roles list");
    }
  });
  roles
    .command("create")
    .requiredOption("--name <name>")
    .option("--description <text>")
    .action(async (o: { name: string; description?: string }) => {
      try {
        emit(
          ctx,
          await api(ctx, "POST", "/api/roles", {
            body: { name: o.name, description: o.description }
          })
        );
      } catch (e) {
        fail(e, "roles create");
      }
    });
  roles
    .command("set-permissions <name>")
    .requiredOption(
      "--permissions <csv>",
      "comma-separated permission names (e.g. pipeline:run,execution:view_logs)"
    )
    .action(async (name: string, o: { permissions: string }) => {
      try {
        const permissions = o.permissions.split(",").map((s) => s.trim()).filter(Boolean);
        emit(
          ctx,
          await api(ctx, "PUT", `/api/roles/${encodeURIComponent(name)}/permissions`, {
            body: { permissions }
          })
        );
      } catch (e) {
        fail(e, "roles set-permissions");
      }
    });
  roles
    .command("delete <name>")
    .option("--force", "Cascade-delete: drop every grant holding the role first, then delete the role catalog row. Default refuses with the grant count.")
    .action(async (name: string, o: { force?: boolean }) => {
      await runDelete(
        ctx,
        "roles delete",
        `/api/roles/${encodeURIComponent(name)}`,
        { force: o.force }
      );
      emit(ctx, { ok: true });
    });

  // ---- identity providers ----------------------------------------------
  const idp = program
    .command("identity-providers")
    .description("OIDC / SAML SSO connections");
  idp.command("list").action(async () => {
    try {
      emit(ctx, await api(ctx, "GET", "/api/identity-providers"));
    } catch (e) {
      fail(e, "identity-providers list");
    }
  });
  idp
    .command("create")
    .requiredOption("--slug <slug>")
    .requiredOption("--kind <kind>", "oidc | saml")
    .requiredOption("--display-name <name>")
    .option("--config <json>", "provider config JSON", "{}")
    .action(async (o: { slug: string; kind: string; displayName: string; config: string }) => {
      try {
        const config = JSON.parse(o.config);
        emit(
          ctx,
          await api(ctx, "POST", "/api/identity-providers", {
            body: { slug: o.slug, kind: o.kind, displayName: o.displayName, config }
          })
        );
      } catch (e) {
        fail(e, "identity-providers create");
      }
    });
  idp
    .command("delete <id>")
    .action(async (id: string) => {
      try {
        await api(ctx, "DELETE", `/api/identity-providers/${id}`);
        emit(ctx, { ok: true });
      } catch (e) {
        fail(e, "identity-providers delete");
      }
    });
}
