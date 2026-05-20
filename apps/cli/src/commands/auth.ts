/**
 * `ragdoll login / logout / whoami / auth-settings`.
 *
 * Login stores the issued session token in the on-disk config so subsequent
 * commands re-use it; `--api-key` skips the login round-trip and just saves a
 * static `rgd_…` key.
 */
import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { patchConfig } from "../config.ts";
import { api, emit, fail, type Ctx } from "../ctx.ts";

async function promptPassword(label: string): Promise<string> {
  // We don't disable echo (Node has no portable way) — the prompt warns.
  process.stderr.write(`${label}: `);
  const rl = createInterface({ input, output });
  const answer = await rl.question("");
  rl.close();
  return answer.trim();
}

export function registerAuth(program: Command, ctx: Ctx): void {
  program
    .command("login")
    .description("Sign in (email + password) or save a static API key")
    .option("--email <email>", "email for password login")
    .option("--password <pwd>", "password (omit to prompt; visible in tty)")
    .option("--api-key <key>", "save a `rgd_…` API key instead of password login")
    .action(async (opts: { email?: string; password?: string; apiKey?: string }) => {
      try {
        if (opts.apiKey) {
          await patchConfig({ apiKey: opts.apiKey, token: undefined });
          emit(ctx, { ok: true, mode: "api-key" });
          return;
        }
        if (!opts.email) throw new Error("--email or --api-key is required");
        const password = opts.password ?? (await promptPassword("password"));
        const res = await api<{ token: string; user: { email: string } }>(
          ctx,
          "POST",
          "/api/auth/login",
          { body: { email: opts.email, password }, noAuth: true }
        );
        await patchConfig({ token: res.token, apiKey: undefined });
        emit(ctx, { ok: true, mode: "session", user: res.user.email });
      } catch (e) {
        fail(e, "login");
      }
    });

  program
    .command("logout")
    .description("Discard the saved session token and API key")
    .action(async () => {
      await patchConfig({ token: undefined, apiKey: undefined });
      emit(ctx, { ok: true });
    });

  program
    .command("whoami")
    .description("Show the current principal, grants, and effective permissions")
    .action(async () => {
      try {
        emit(ctx, await api(ctx, "GET", "/api/auth/me"));
      } catch (e) {
        fail(e, "whoami");
      }
    });

  // ---- /api/auth/settings ------------------------------------------------
  const settings = program
    .command("auth-settings")
    .description("Inspect / change the instance signup mode");
  settings
    .command("get")
    .action(async () => {
      try {
        emit(ctx, await api(ctx, "GET", "/api/auth/settings"));
      } catch (e) {
        fail(e, "auth-settings get");
      }
    });
  settings
    .command("set")
    .requiredOption(
      "--mode <mode>",
      "admin_only | open_default_role | open_no_access"
    )
    .option("--default-role <role>", "role to grant on open_default_role signup")
    .action(async (opts: { mode: string; defaultRole?: string }) => {
      try {
        emit(
          ctx,
          await api(ctx, "PUT", "/api/auth/settings", {
            body: {
              signupMode: opts.mode,
              defaultRole: opts.defaultRole ?? null
            }
          })
        );
      } catch (e) {
        fail(e, "auth-settings set");
      }
    });
}
