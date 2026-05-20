import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_API_URL,
  authHeadersFor,
  configPath,
  loadConfig,
  patchConfig,
  saveConfig
} from "../src/config.ts";

async function withTmpConfig<T>(
  fn: (path: string, env: NodeJS.ProcessEnv) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ragdoll-cli-test-"));
  const path = join(dir, "config.json");
  try {
    return await fn(path, { ...process.env, RAGDOLL_CONFIG: path });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("configPath honours RAGDOLL_CONFIG over the default", () => {
  assert.equal(configPath({ RAGDOLL_CONFIG: "/tmp/x.json" }), "/tmp/x.json");
  assert.match(
    configPath({ HOME: "/home/x" }),
    /\/home\/x\/\.ragdoll\/config\.json$/
  );
});

test("loadConfig: env wins over file wins over built-in defaults", async () => {
  await withTmpConfig(async (path, env) => {
    // empty file -> built-in default URL.
    assert.equal((await loadConfig(env)).apiUrl, DEFAULT_API_URL);

    await writeFile(path, JSON.stringify({ apiUrl: "http://api.example.test" }));
    assert.equal((await loadConfig(env)).apiUrl, "http://api.example.test");

    const envOverride = { ...env, RAGDOLL_API_URL: "http://from-env.test" };
    assert.equal((await loadConfig(envOverride)).apiUrl, "http://from-env.test");
  });
});

test("patchConfig merges with the on-disk state, persists 0600", async () => {
  await withTmpConfig(async (path, env) => {
    await saveConfig(
      { apiUrl: DEFAULT_API_URL, token: "tok1", tenantId: "t1" },
      env
    );
    const after = await patchConfig({ tenantId: "t2" }, env);
    assert.equal(after.token, "tok1"); // preserved
    assert.equal(after.tenantId, "t2"); // patched
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    assert.equal(onDisk.token, "tok1");
    assert.equal(onDisk.tenantId, "t2");
  });
});

test("authHeadersFor: bearer / api-key / tenant only when configured", () => {
  assert.deepEqual(authHeadersFor({ apiUrl: "x" }), {});
  assert.deepEqual(
    authHeadersFor({ apiUrl: "x", token: "tok", tenantId: "t" }),
    { authorization: "Bearer tok", "x-tenant-id": "t" }
  );
  assert.deepEqual(authHeadersFor({ apiUrl: "x", apiKey: "rgd_k" }), {
    "x-api-key": "rgd_k"
  });
});
