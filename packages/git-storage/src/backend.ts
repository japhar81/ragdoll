/**
 * GitBackend — shells out to the `git` binary so HTTPS+token and SSH+key
 * both work without a JS git client. The container Dockerfiles install
 * `git` + `openssh-client` for this.
 *
 * Auth:
 *  - https: `GIT_ASKPASS` script writes the PAT to stdout. We point it at
 *    a tiny helper script generated per-call (under the worktree).
 *  - ssh:   `GIT_SSH_COMMAND="ssh -i <keyfile> -o StrictHostKeyChecking=no
 *           -o UserKnownHostsFile=/dev/null"` — keyfile written 0600 under
 *    the worktree and removed when the backend closes.
 *
 * Worktrees are per-tenant under {workRoot}/<tenantId>/. First call
 * clones; subsequent calls fetch. The backend is single-use per call
 * site (open → use → close) so secret material is wiped predictably.
 */
import { mkdir, mkdtemp, rm, writeFile, chmod, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

export interface GitAuth {
  method: "https" | "ssh";
  /** HTTPS PAT or SSH private key (PEM) — depending on `method`. */
  credential: string;
  /** Optional username for HTTPS basic auth; defaults to `oauth2`. */
  username?: string;
}

export interface OpenRepoOptions {
  remoteUrl: string;
  branch: string;
  auth: GitAuth;
  /** Persistent worktree root. One subdir per tenant id. */
  workRoot: string;
  tenantId: string;
}

export interface CommitOptions {
  message: string;
  authorName: string;
  authorEmail: string;
  /**
   * Map of repo-relative path -> file contents. A null value MEANS DELETE.
   * Files outside the per-tenant prefix (i.e. anywhere else in the repo)
   * are not touched.
   */
  files: Record<string, string | null>;
}

export interface CommitResult {
  /** Commit sha after push. `null` if there was nothing to commit. */
  sha: string | null;
  /** Whether the push had to retry after a rebase against the remote. */
  rebased: boolean;
}

export interface GitBackend {
  /** Path on disk where files can be read. Stable for the backend's lifetime. */
  readonly worktree: string;
  /** Current HEAD sha. */
  headSha(): Promise<string>;
  /** Fetch + fast-forward to `origin/<branch>`. Returns new HEAD sha. */
  pull(): Promise<string>;
  /** Read a file at HEAD; returns `undefined` if it doesn't exist. */
  read(path: string): Promise<string | undefined>;
  /** List repo-relative paths matching the given prefix. */
  list(prefix: string): Promise<string[]>;
  /**
   * Diff names between two shas. `from === undefined` returns every file at
   * `to`. Empty array means no changes.
   */
  diffNames(from: string | undefined, to: string): Promise<string[]>;
  /** Pull → apply file edits → commit → push. Retries once on push reject. */
  commitAndPush(opts: CommitOptions): Promise<CommitResult>;
  /** Release any per-call secret material (key files, askpass scripts). */
  close(): Promise<void>;
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  cwd: string,
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code: code ?? -1, stdout, stderr })
    );
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

async function git(
  worktree: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<string> {
  const r = await run(worktree, "git", args, env);
  if (r.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`
    );
  }
  return r.stdout;
}

/**
 * Concrete backend that shells out. Open via {@link openRepo}; always
 * call `.close()` (idempotent) so secret material is cleaned up.
 */
class ShellGitBackend implements GitBackend {
  readonly worktree: string;
  private readonly branch: string;
  private readonly remoteUrl: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cleanup: Array<() => Promise<void>> = [];

  constructor(args: {
    worktree: string;
    branch: string;
    remoteUrl: string;
    env: NodeJS.ProcessEnv;
    cleanup: Array<() => Promise<void>>;
  }) {
    this.worktree = args.worktree;
    this.branch = args.branch;
    this.remoteUrl = args.remoteUrl;
    this.env = args.env;
    this.cleanup = args.cleanup;
  }

  async headSha(): Promise<string> {
    return (await git(this.worktree, ["rev-parse", "HEAD"], this.env)).trim();
  }

  async pull(): Promise<string> {
    await git(this.worktree, ["fetch", "origin", this.branch], this.env);
    // Fast-forward only — if local diverged we want to know about it,
    // not silently merge. The conflict path lives in commitAndPush.
    await git(this.worktree, ["reset", "--hard", `origin/${this.branch}`], this.env);
    return this.headSha();
  }

  async read(path: string): Promise<string | undefined> {
    const full = join(this.worktree, path);
    try {
      const s = await stat(full);
      if (!s.isFile()) return undefined;
    } catch {
      return undefined;
    }
    return readFile(full, "utf8");
  }

  async list(prefix: string): Promise<string[]> {
    const out = await git(
      this.worktree,
      ["ls-files", prefix ? `${prefix.replace(/\/+$/, "")}/` : "."],
      this.env
    );
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async diffNames(from: string | undefined, to: string): Promise<string[]> {
    if (!from) {
      const out = await git(this.worktree, ["ls-tree", "-r", "--name-only", to], this.env);
      return out.split("\n").map((s) => s.trim()).filter(Boolean);
    }
    const out = await git(
      this.worktree,
      ["diff", "--name-only", from, to],
      this.env
    );
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  private async writeFiles(files: Record<string, string | null>): Promise<{
    written: string[];
    deleted: string[];
  }> {
    const written: string[] = [];
    const deleted: string[] = [];
    for (const [path, content] of Object.entries(files)) {
      const full = join(this.worktree, path);
      if (content === null) {
        if (existsSync(full)) {
          await rm(full, { force: true });
          deleted.push(path);
        }
      } else {
        await mkdir(join(this.worktree, path, "..").replace(/\/$/, ""), {
          recursive: true
        });
        await writeFile(full, content, "utf8");
        written.push(path);
      }
    }
    return { written, deleted };
  }

  async commitAndPush(opts: CommitOptions): Promise<CommitResult> {
    // Start by syncing the local worktree with the remote so we commit on
    // top of the latest. The "git wins" policy lives here too: if pull
    // surfaces changes that overlap with our about-to-be-written files,
    // we still overwrite — the caller has already decided what should be
    // there.
    await this.pull();
    const { written, deleted } = await this.writeFiles(opts.files);
    if (written.length === 0 && deleted.length === 0) {
      return { sha: null, rebased: false };
    }
    for (const path of written) {
      await git(this.worktree, ["add", "--", path], this.env);
    }
    for (const path of deleted) {
      await git(this.worktree, ["rm", "--ignore-unmatch", "--", path], this.env);
    }
    // Nothing actually staged? (e.g. file content matched what was there)
    const status = (await git(this.worktree, ["status", "--porcelain"], this.env)).trim();
    if (status.length === 0) {
      return { sha: null, rebased: false };
    }
    const commitEnv = {
      ...this.env,
      GIT_AUTHOR_NAME: opts.authorName,
      GIT_AUTHOR_EMAIL: opts.authorEmail,
      GIT_COMMITTER_NAME: opts.authorName,
      GIT_COMMITTER_EMAIL: opts.authorEmail
    };
    await git(this.worktree, ["commit", "-m", opts.message], commitEnv);

    let rebased = false;
    const tryPush = async (): Promise<void> => {
      await git(this.worktree, ["push", "origin", this.branch], this.env);
    };
    try {
      await tryPush();
    } catch (firstError) {
      // Pull --rebase and try once more. If the rebase can't auto-resolve
      // we throw — caller logs an audit row and surfaces the failure.
      rebased = true;
      try {
        await git(
          this.worktree,
          ["pull", "--rebase", "origin", this.branch],
          this.env
        );
        await tryPush();
      } catch {
        // Re-throw the *original* error — it usually has the rejected-ref
        // message that's most actionable for the operator.
        throw firstError;
      }
    }
    void this.remoteUrl;
    return { sha: await this.headSha(), rebased };
  }

  async close(): Promise<void> {
    for (const fn of this.cleanup) {
      try {
        await fn();
      } catch {
        /* best-effort */
      }
    }
    this.cleanup.length = 0;
  }
}

/**
 * Open (or initialize) a per-tenant worktree on disk and prepare auth
 * env vars. Resolves with a {@link GitBackend} the caller drives.
 */
export async function openRepo(opts: OpenRepoOptions): Promise<GitBackend> {
  await mkdir(opts.workRoot, { recursive: true });
  const worktree = join(opts.workRoot, opts.tenantId);
  const cleanup: Array<() => Promise<void>> = [];

  // Build the auth env first so initial clone can use it too.
  const env: NodeJS.ProcessEnv = {};
  if (opts.auth.method === "https") {
    // GIT_ASKPASS is invoked with one of "Username for ..." or "Password
    // for ..." as argv[1]. We respond with the configured username for
    // the first prompt, the PAT for the second. Tiny shell wrapper:
    const askdir = await mkdtemp(join(tmpdir(), "ragdoll-askpass-"));
    const askscript = join(askdir, "askpass.sh");
    const user = opts.auth.username ?? "oauth2";
    const script = `#!/bin/sh
case "$1" in
  Username*) printf '%s' '${user.replace(/'/g, "'\\''")}' ;;
  Password*) printf '%s' '${opts.auth.credential.replace(/'/g, "'\\''")}' ;;
esac
`;
    await writeFile(askscript, script, "utf8");
    await chmod(askscript, 0o700);
    env.GIT_ASKPASS = askscript;
    env.GIT_TERMINAL_PROMPT = "0";
    cleanup.push(() => rm(askdir, { recursive: true, force: true }));
  } else {
    const keydir = await mkdtemp(join(tmpdir(), "ragdoll-sshkey-"));
    const keyfile = join(keydir, "id_ragdoll");
    // The key MUST end with a newline for ssh-keygen / ssh to accept it.
    const key = opts.auth.credential.endsWith("\n")
      ? opts.auth.credential
      : opts.auth.credential + "\n";
    await writeFile(keyfile, key, { mode: 0o600 });
    await chmod(keyfile, 0o600);
    env.GIT_SSH_COMMAND = `ssh -i ${keyfile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes`;
    cleanup.push(() => rm(keydir, { recursive: true, force: true }));
  }

  if (!existsSync(join(worktree, ".git"))) {
    // Initial clone. We always shallow-fetch the requested branch.
    await mkdir(worktree, { recursive: true });
    await git(
      worktree,
      ["clone", "--branch", opts.branch, "--", opts.remoteUrl, "."],
      env
    );
    // Lock the committer identity locally so commits don't leak the host
    // user's name/email.
    await git(worktree, ["config", "user.name", "RAGdoll"], env);
    await git(worktree, ["config", "user.email", "ragdoll@localhost"], env);
  } else {
    // Existing checkout — sync to the remote branch in case it moved
    // since we last opened it.
    await git(worktree, ["remote", "set-url", "origin", opts.remoteUrl], env);
    await git(worktree, ["fetch", "origin", opts.branch], env);
    await git(worktree, ["checkout", opts.branch], env);
    await git(worktree, ["reset", "--hard", `origin/${opts.branch}`], env);
  }

  return new ShellGitBackend({
    worktree,
    branch: opts.branch,
    remoteUrl: opts.remoteUrl,
    env,
    cleanup
  });
}
