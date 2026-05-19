import test from "node:test";
import assert from "node:assert/strict";
import { PasswordService, WeakPasswordError } from "../src/password.ts";

// Small scrypt params keep the suite fast while exercising the real code path.
const svc = new PasswordService({ N: 1024, r: 8, p: 1 });

test("hash then verify round-trips", async () => {
  const stored = await svc.hash("correct horse battery");
  assert.match(stored, /^scrypt\$1024\$8\$1\$/);
  assert.equal(await svc.verify("correct horse battery", stored), true);
  assert.equal(await svc.verify("wrong password", stored), false);
});

test("verify is robust to malformed / empty stored hashes", async () => {
  assert.equal(await svc.verify("x", null), false);
  assert.equal(await svc.verify("x", ""), false);
  assert.equal(await svc.verify("x", "not-a-hash"), false);
  assert.equal(await svc.verify("x", "scrypt$bad$bad$bad$zz$zz"), false);
});

test("weak passwords are rejected at hash time", async () => {
  await assert.rejects(() => svc.hash("short"), WeakPasswordError);
});

test("a different verifier with different params still verifies", async () => {
  const stored = await svc.hash("a-strong-passphrase");
  // Params are read from the stored string, not the instance.
  const other = new PasswordService({ N: 1 << 14 });
  assert.equal(await other.verify("a-strong-passphrase", stored), true);
});
