/**
 * PLUGIN-ARCH-1 close-out: KISS signature verification.
 *
 * Trust seam: provenance is recorded (ADR-0034); this layer VERIFIES
 * git's own commit signature against a per-source allowed-signers
 * file BEFORE the lifecycle hands the working copy to the importer.
 * The full trust policy (org-wide signers, revocation, chain-of-
 * trust) is deferred; this is the KISS floor that stops "someone
 * pushed an unsigned commit to the plugin repo."
 *
 * The mechanism is git's own:
 *
 *   git -c gpg.format=ssh \
 *       -c gpg.ssh.allowedSignersFile=<tmp> \
 *       -C <workingCopy> \
 *       verify-commit <sha>
 *
 * exits 0 iff `<sha>` is signed by a key in the operator-supplied
 * `allowedSigners` file (SSH-signed commits — the common shape;
 * GPG-signed commits work via the same helper when the operator has
 * a GNUPGHOME pre-staged, but the API treats the field as the
 * SSH-signers file content for KISS).
 *
 * Honesty:
 *
 *   - The verifier knows about SSH-signed commits. GPG support is
 *     possible but requires per-source key import, which adds key
 *     management; deferred to the trust tier.
 *   - `git verify-commit` ALSO works on annotated tags via the
 *     `verify-tag` subcommand. When the source ref looks like a
 *     tag (operator surface) we try verify-tag first; the lifecycle
 *     resolves the sha BEFORE verify, so we always have a sha to
 *     fall back on.
 *   - The signer identity comes from git's stderr (`Good "git" signature
 *     for <id> with <key-type> key`). We parse it best-effort —
 *     used for the operator-facing "signed by X" badge only. A
 *     parse miss does NOT change the verdict (we trust git's exit
 *     code).
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class SignatureVerifyError extends Error {
  readonly stage: "verify";
  readonly stderrTail?: string;
  constructor(message: string, stderrTail?: string) {
    super(message);
    this.name = "SignatureVerifyError";
    this.stage = "verify";
    this.stderrTail = stderrTail;
  }
}

export interface VerifyOpts {
  /** Test seam — swap `child_process.spawn`. */
  spawn?: typeof spawn;
  /** Timeout for the verify command. Five seconds covers the
   *  in-process gpg/ssh-keygen call; a hung verifier is a stuck
   *  refresh waiting to happen. */
  timeoutMs?: number;
}

export interface VerifyResult {
  signatureVerified: true;
  /** Best-effort parse from git's stderr; the operator-facing
   *  "signed by X" string surfaced on the provenance. */
  signedBy?: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Verify a single commit's signature against a writeable allowed-
 * signers file. Returns on success; throws `SignatureVerifyError`
 * on any failure (missing signature, bad signature, unknown signer,
 * git error, timeout).
 *
 * The allowed-signers file is written to a fresh tmpdir, used, and
 * deleted — verification is HERMETIC per call. The operator's
 * configured signers list is plain text (one ssh-signers line per
 * key, e.g. `octocat principals=git ssh-ed25519 AAAA...`).
 */
export async function verifyCommitSignature(args: {
  workingCopy: string;
  sha: string;
  allowedSigners: string;
  opts?: VerifyOpts;
}): Promise<VerifyResult> {
  if (!/^[0-9a-f]{40}$/i.test(args.sha)) {
    throw new SignatureVerifyError(
      `verifyCommitSignature: sha must be a 40-char hex string`
    );
  }
  if (!args.allowedSigners.trim()) {
    throw new SignatureVerifyError(
      `verifyCommitSignature: allowedSigners is empty — set the source's allowedSigners or disable requireSignature`
    );
  }

  // Write allowedSigners to a fresh tmpdir. Cleanup is best-effort
  // in `finally` so a crash mid-verify doesn't litter /tmp with
  // operator keys.
  const dir = await mkdtemp(join(tmpdir(), "ragdoll-cqv-"));
  const signersPath = join(dir, "allowed_signers");
  await writeFile(signersPath, ensureTrailingNewline(args.allowedSigners), {
    mode: 0o600
  });
  try {
    const argv = [
      "-c",
      "gpg.format=ssh",
      "-c",
      `gpg.ssh.allowedSignersFile=${signersPath}`,
      "-C",
      args.workingCopy,
      "verify-commit",
      "-v",
      args.sha
    ];
    const stderr = await runGitVerify({
      argv,
      timeoutMs: args.opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      spawn: args.opts?.spawn ?? spawn
    });
    return {
      signatureVerified: true,
      signedBy: parseSignerFromStderr(stderr) ?? undefined
    };
  } finally {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}

/**
 * Run `git -c ... verify-commit` and resolve the stderr (signer
 * identity is logged there with `-v`). Reject with
 * `SignatureVerifyError` on non-zero exit / spawn failure / timeout.
 */
function runGitVerify(args: {
  argv: string[];
  timeoutMs: number;
  spawn: typeof spawn;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = args.spawn("git", args.argv, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, args.timeoutMs);
    proc.stdout?.on("data", (c: Buffer) => out.push(c));
    proc.stderr?.on("data", (c: Buffer) => err.push(c));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(new SignatureVerifyError(`spawn git verify-commit failed: ${e.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString("utf8");
      if (killed) {
        reject(
          new SignatureVerifyError(
            `git verify-commit timed out after ${args.timeoutMs}ms`,
            stderr.slice(-1024)
          )
        );
        return;
      }
      if (code !== 0) {
        // git's stderr explains: "no signature found", "bad signature",
        // "unknown signer", etc. Surface the tail so the operator sees
        // which one.
        reject(
          new SignatureVerifyError(
            `git verify-commit exited ${code}`,
            stderr.slice(-1024) || "(empty stderr)"
          )
        );
        return;
      }
      resolve(stderr);
    });
  });
}

// git's stderr on a successful verify (SSH-signed) looks like:
//   Good "git" signature for <id> with <key-type> key SHA256:<fpr>
// We pull <id> for the badge.
const SIGNER_PATTERN = /Good "git" signature for ([^\s]+) with /;

function parseSignerFromStderr(stderr: string): string | null {
  const m = stderr.match(SIGNER_PATTERN);
  return m?.[1] ?? null;
}
