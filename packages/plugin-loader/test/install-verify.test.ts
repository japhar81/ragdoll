/**
 * PLUGIN-ARCH-1 close-out: install + verify lifecycle stages.
 *
 * These tests pin the new failure modes (install / verify) and the
 * load-bearing properties:
 *
 *   - install runs ONCE per (repoId, sha) — a second load of the
 *     same sha hits the per-sha plugin cache and the install fn is
 *     never invoked again
 *   - install failure is `failed{stage:'install'}` with stderr,
 *     isolated, the plugin doesn't load
 *   - verify runs WHEN `requireSignature: true` and `allowedSigners`
 *     is set; bad/missing signature is `failed{stage:'verify'}` and
 *     the plugin does NOT load (and the install step is NEVER
 *     reached — untrusted source can't trigger npm install)
 *   - verify=true + allowedSigners empty is a loud refusal at
 *     `verify` stage (don't silently accept un-verifyable sources)
 *   - signature result rides on `RegisteredPlugin.source` provenance
 *     so /api/plugins shows `signedBy` / `signatureVerified`
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  __clearPluginCacheForTests,
  loadSource
} from "../src/lifecycle.ts";
import { PluginRegistry } from "../../plugin-sdk/src/index.ts";
import type { PluginSource } from "../src/sources.ts";

function makeStubPlugin(id: string): unknown {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      category: "datasource",
      description: "test"
    },
    execute: async () => ({ outputs: {} })
  };
}

const fixedSha = (n: string): string => n.repeat(40);

const gitSource = (overrides: Partial<PluginSource> = {}): PluginSource => ({
  id: "ext-sig",
  kind: "git",
  enabled: true,
  gitUrl: "https://example.invalid/ext.git",
  ref: fixedSha("a"),
  ...overrides
});

// --------------------------------------------------------------------------
// install
// --------------------------------------------------------------------------

test("install: installFn is invoked exactly ONCE per (repoId, sha); a second load hits cache and skips it", async () => {
  __clearPluginCacheForTests();
  const registry1 = new PluginRegistry();
  const registry2 = new PluginRegistry();
  const sha = fixedSha("1");
  let calls = 0;
  const installFn = async () => {
    calls += 1;
  };
  const importFn = async () => ({ p: makeStubPlugin("install_plug") });
  const source = gitSource({ ref: sha });
  await loadSource(source, registry1, { skipFetch: true, importFn, installFn });
  assert.equal(calls, 1, "install must run once on first load");
  await loadSource(source, registry2, { skipFetch: true, importFn, installFn });
  assert.equal(calls, 1, "second load must hit cache and skip install");
  assert.ok(
    registry1.get({ category: "datasource", id: "install_plug", version: "1.0.0" })
  );
  assert.ok(
    registry2.get({ category: "datasource", id: "install_plug", version: "1.0.0" })
  );
});

test("install: installFn throwing surfaces as failed{stage:'install'} with the error message; no plugin loads", async () => {
  __clearPluginCacheForTests();
  const registry = new PluginRegistry();
  const sha = fixedSha("8");
  const source = gitSource({ ref: sha });
  const status = await loadSource(source, registry, {
    skipFetch: true,
    importFn: async () => ({ p: makeStubPlugin("never_loads") }),
    installFn: async () => {
      throw new Error("npm install exited 1: EBADENGINE");
    }
  });
  assert.equal(status.status, "failed");
  assert.equal(status.errorStage, "install");
  assert.match(status.error ?? "", /EBADENGINE/);
  assert.equal(registry.list().length, 0);
});

test("install: skipInstall=true bypasses installFn entirely (operator-knob; or test seam for non-install paths)", async () => {
  __clearPluginCacheForTests();
  const registry = new PluginRegistry();
  const sha = fixedSha("9");
  let calls = 0;
  await loadSource(gitSource({ ref: sha }), registry, {
    skipFetch: true,
    skipInstall: true,
    importFn: async () => ({ p: makeStubPlugin("skip_install_plug") }),
    installFn: async () => {
      calls += 1;
    }
  });
  assert.equal(calls, 0);
});

// --------------------------------------------------------------------------
// install — the lifecycle-side surface check we CAN exercise without
// touching the filesystem: an install failure surfaces as failed{stage:'install'}.
// We do this by exercising the lifecycle through a path that goes
// through install (we patch the resolveBuiltinPath to point at a
// real on-disk dir AND set requireSignature=false / skipInstall=false).
// The lifecycle currently only runs install for git sources with a
// real workingCopyPath, so we need to convince it we have one.
//
// Approach: extend the lifecycle's seam by exposing the workingCopyPath
// via a test-only override. We don't want to do that just for tests —
// instead test the `ensureDependenciesInstalled` helper directly,
// and confirm the lifecycle surfaces an install error via a verify
// path that mirrors the error shape.
// --------------------------------------------------------------------------

test("verify: requireSignature=true + bad signature → failed{stage:'verify'}, install never runs, no plugin registered", async () => {
  __clearPluginCacheForTests();
  const registry = new PluginRegistry();
  const sha = fixedSha("2");
  let installCalls = 0;
  const status = await loadSource(
    gitSource({
      ref: sha,
      requireSignature: true,
      allowedSigners: "octocat ssh-ed25519 AAAA"
    }),
    registry,
    {
      skipFetch: true,
      importFn: async () => ({ p: makeStubPlugin("untrusted_plug") }),
      installFn: async () => {
        installCalls += 1;
      },
      verifyFn: async () => {
        throw new Error("git verify-commit exited 1: unknown signer");
      }
    }
  );
  assert.equal(status.status, "failed");
  assert.equal(status.errorStage, "verify");
  assert.match(status.error ?? "", /unknown signer/i);
  // Install MUST NOT run on an untrusted source — that's the
  // load-bearing invariant of running verify before install.
  assert.equal(installCalls, 0);
  assert.equal(registry.list().length, 0);
});

test("verify: requireSignature=true + empty allowedSigners → failed{stage:'verify'} BEFORE invoking verifyFn (loud refusal)", async () => {
  __clearPluginCacheForTests();
  const registry = new PluginRegistry();
  let verifyCalls = 0;
  const status = await loadSource(
    gitSource({
      ref: "a".padEnd(40, "1"),
      requireSignature: true,
      allowedSigners: "   "
    }),
    registry,
    {
      skipFetch: true,
      importFn: async () => ({}),
      verifyFn: async () => {
        verifyCalls += 1;
        return { signatureVerified: true };
      }
    }
  );
  assert.equal(status.status, "failed");
  assert.equal(status.errorStage, "verify");
  assert.match(status.error ?? "", /allowedSigners/i);
  assert.equal(verifyCalls, 0);
});

test("verify: requireSignature=true + successful verify stamps signatureVerified + signedBy on provenance AND status", async () => {
  __clearPluginCacheForTests();
  const registry = new PluginRegistry();
  const sha = "a".padEnd(40, "2");
  const status = await loadSource(
    gitSource({
      ref: sha,
      requireSignature: true,
      allowedSigners: "octocat ssh-ed25519 AAAA"
    }),
    registry,
    {
      skipFetch: true,
      importFn: async () => ({ p: makeStubPlugin("signed_plug") }),
      installFn: async () => {
        /* no-op */
      },
      verifyFn: async () => ({
        signatureVerified: true,
        signedBy: "octocat"
      })
    }
  );
  assert.equal(status.status, "loaded");
  assert.equal(status.signatureVerified, true);
  assert.equal(status.signedBy, "octocat");
  const plugin = registry.get({
    category: "datasource",
    id: "signed_plug",
    version: "1.0.0"
  });
  // Provenance carries the verification — surfaced on /api/plugins
  // so the operator sees the signed-by badge.
  assert.equal(plugin?.source?.signatureVerified, true);
  assert.equal(plugin?.source?.signedBy, "octocat");
});

test("verify: requireSignature=false → verifyFn NEVER called (signing is opt-in per source)", async () => {
  __clearPluginCacheForTests();
  const registry = new PluginRegistry();
  let verifyCalls = 0;
  const status = await loadSource(
    gitSource({ ref: "a".padEnd(40, "3") }),
    registry,
    {
      skipFetch: true,
      importFn: async () => ({ p: makeStubPlugin("unsigned_plug") }),
      verifyFn: async () => {
        verifyCalls += 1;
        return { signatureVerified: true };
      }
    }
  );
  assert.equal(status.status, "loaded");
  assert.equal(verifyCalls, 0);
  // No signature fields on the status / provenance when verify
  // wasn't performed.
  assert.equal(status.signatureVerified, undefined);
  const p = registry.get({
    category: "datasource",
    id: "unsigned_plug",
    version: "1.0.0"
  });
  assert.equal(p?.source?.signatureVerified, undefined);
});

// --------------------------------------------------------------------------
// verify helper — direct surface tests on the helper used by the
// lifecycle. These cover what we can deterministically test without
// a real git clone.
// --------------------------------------------------------------------------

test("verifyCommitSignature helper: empty allowedSigners is refused with a clear error", async () => {
  const { verifyCommitSignature, SignatureVerifyError } = await import(
    "../src/verify-signature.ts"
  );
  await assert.rejects(
    () =>
      verifyCommitSignature({
        workingCopy: "/tmp/does-not-matter",
        sha: fixedSha("3"),
        allowedSigners: "   "
      }),
    (e: unknown) =>
      e instanceof SignatureVerifyError &&
      /allowedSigners is empty/i.test(e.message)
  );
});

test("verifyCommitSignature helper: a bad sha is refused before spawning git", async () => {
  const { verifyCommitSignature, SignatureVerifyError } = await import(
    "../src/verify-signature.ts"
  );
  await assert.rejects(
    () =>
      verifyCommitSignature({
        workingCopy: "/tmp/whatever",
        sha: "not-a-sha",
        allowedSigners: "octocat ssh-ed25519 AAAA"
      }),
    (e: unknown) =>
      e instanceof SignatureVerifyError &&
      /sha must be a 40-char hex string/.test(e.message)
  );
});

test("verifyCommitSignature helper: a non-zero exit from git is surfaced as SignatureVerifyError with stderr tail (verify-bad-signature path)", async () => {
  const { verifyCommitSignature, SignatureVerifyError } = await import(
    "../src/verify-signature.ts"
  );
  // Inject a fake spawn that immediately exits non-zero with a
  // canned stderr — mirrors git's behaviour on a bad signature.
  const fakeSpawn = ((..._args: unknown[]) => {
    const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
    const proc = {
      stdout: {
        on: (event: string, fn: (arg?: unknown) => void) => {
          (listeners[event] ||= []).push(fn);
        }
      },
      stderr: {
        on: (event: string, fn: (arg?: unknown) => void) => {
          (listeners[`stderr:${event}`] ||= []).push(fn);
        }
      },
      on: (event: string, fn: (arg?: unknown) => void) => {
        (listeners[event] ||= []).push(fn);
      },
      kill: () => {
        /* unused */
      }
    };
    setImmediate(() => {
      (listeners["stderr:data"] ?? []).forEach((fn) =>
        fn(Buffer.from("error: gpg.ssh.allowedSignersFile rejected: unknown signer\n"))
      );
      (listeners["close"] ?? []).forEach((fn) => fn(1));
    });
    return proc;
  }) as unknown as typeof import("node:child_process").spawn;
  await assert.rejects(
    () =>
      verifyCommitSignature({
        workingCopy: "/tmp/anything",
        sha: fixedSha("4"),
        allowedSigners: "octocat ssh-ed25519 AAAA",
        opts: { spawn: fakeSpawn }
      }),
    (e: unknown) =>
      e instanceof SignatureVerifyError &&
      /exited 1/.test(e.message) &&
      /unknown signer/i.test(e.stderrTail ?? "")
  );
});

test("verifyCommitSignature helper: a successful verify returns the parsed signer identity", async () => {
  const { verifyCommitSignature } = await import("../src/verify-signature.ts");
  // Fake spawn that exits 0 with git's canonical success stderr.
  const fakeSpawn = ((..._args: unknown[]) => {
    const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
    const proc = {
      stdout: {
        on: (event: string, fn: (arg?: unknown) => void) => {
          (listeners[event] ||= []).push(fn);
        }
      },
      stderr: {
        on: (event: string, fn: (arg?: unknown) => void) => {
          (listeners[`stderr:${event}`] ||= []).push(fn);
        }
      },
      on: (event: string, fn: (arg?: unknown) => void) => {
        (listeners[event] ||= []).push(fn);
      },
      kill: () => {
        /* unused */
      }
    };
    setImmediate(() => {
      (listeners["stderr:data"] ?? []).forEach((fn) =>
        fn(
          Buffer.from(
            'Good "git" signature for octocat with ED25519 key SHA256:abc\n'
          )
        )
      );
      (listeners["close"] ?? []).forEach((fn) => fn(0));
    });
    return proc;
  }) as unknown as typeof import("node:child_process").spawn;
  const result = await verifyCommitSignature({
    workingCopy: "/tmp/anything",
    sha: fixedSha("5"),
    allowedSigners: "octocat ssh-ed25519 AAAA",
    opts: { spawn: fakeSpawn }
  });
  assert.equal(result.signatureVerified, true);
  assert.equal(result.signedBy, "octocat");
});

// --------------------------------------------------------------------------
// install helper — directly exercise the install function with a
// stub spawn so we can test the cache + failure surfaces honestly.
// --------------------------------------------------------------------------

test("ensureDependenciesInstalled: returns `not-needed` when the working copy has no package.json", async () => {
  const { ensureDependenciesInstalled } = await import(
    "../src/install-deps.ts"
  );
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "ragdoll-install-"));
  const result = await ensureDependenciesInstalled(dir);
  assert.equal(result, "not-needed");
});

test("ensureDependenciesInstalled: returns `already-cached` when the marker file is present (a no-op refresh)", async () => {
  const { ensureDependenciesInstalled, INSTALL_MARKER_BASENAME } = await import(
    "../src/install-deps.ts"
  );
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "ragdoll-install-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
  await writeFile(join(dir, INSTALL_MARKER_BASENAME), "{}");
  const result = await ensureDependenciesInstalled(dir);
  assert.equal(result, "already-cached");
});

test("ensureDependenciesInstalled: a failed install surfaces as InstallError with the stderr tail (per-source isolation contract)", async () => {
  const { ensureDependenciesInstalled, InstallError } = await import(
    "../src/install-deps.ts"
  );
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "ragdoll-install-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
  // Inject a fake spawn that immediately exits non-zero — mirrors
  // npm's behaviour on (e.g.) an unresolvable dep.
  const fakeSpawn = ((..._args: unknown[]) => {
    const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
    const proc = {
      stdout: {
        on: (event: string, fn: (arg?: unknown) => void) => {
          (listeners[event] ||= []).push(fn);
        }
      },
      stderr: {
        on: (event: string, fn: (arg?: unknown) => void) => {
          (listeners[`stderr:${event}`] ||= []).push(fn);
        }
      },
      on: (event: string, fn: (arg?: unknown) => void) => {
        (listeners[event] ||= []).push(fn);
      },
      kill: () => {
        /* unused */
      }
    };
    setImmediate(() => {
      (listeners["stderr:data"] ?? []).forEach((fn) =>
        fn(Buffer.from("npm ERR! 404 Not Found - GET https://...\n"))
      );
      (listeners["close"] ?? []).forEach((fn) => fn(1));
    });
    return proc;
  }) as unknown as typeof import("node:child_process").spawn;
  await assert.rejects(
    () => ensureDependenciesInstalled(dir, { spawn: fakeSpawn }),
    (e: unknown) =>
      e instanceof InstallError &&
      /exited 1/.test(e.message) &&
      /Not Found/.test(e.stderrTail ?? "")
  );
});
