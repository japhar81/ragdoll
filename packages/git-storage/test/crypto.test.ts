/**
 * Per-tenant DEK + secret bundle crypto. Pure unit tests; no I/O.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decryptSecretBundle,
  encryptSecretBundle,
  generateDek,
  unwrapDek,
  wrapDek
} from "../src/crypto.ts";

test("wrapDek round-trips a freshly generated DEK", () => {
  const kek = "instance-kek-string";
  const dek = generateDek();
  const wrapped = wrapDek(dek, kek);
  const unwrapped = unwrapDek(wrapped, kek);
  assert.ok(dek.equals(unwrapped));
});

test("wrapDek output is non-deterministic (fresh IV per call)", () => {
  const kek = "same-kek";
  const dek = generateDek();
  const a = wrapDek(dek, kek);
  const b = wrapDek(dek, kek);
  assert.notEqual(a, b, "two wraps of the same DEK must differ (random IV)");
  assert.ok(unwrapDek(a, kek).equals(unwrapDek(b, kek)));
});

test("unwrapDek with the wrong KEK throws", () => {
  const dek = generateDek();
  const wrapped = wrapDek(dek, "right-kek");
  assert.throws(() => unwrapDek(wrapped, "wrong-kek"));
});

test("encryptSecretBundle round-trips a key/value map", () => {
  const dek = generateDek();
  const plaintext = {
    "llm.api_key": "sk-XXX",
    "qdrant.token": "qdr-YYY",
    empty: ""
  };
  const wire = encryptSecretBundle(plaintext, dek);
  assert.deepEqual(decryptSecretBundle(wire, dek), plaintext);
});

test("decryptSecretBundle with the wrong DEK throws", () => {
  const dek1 = generateDek();
  const dek2 = generateDek();
  const wire = encryptSecretBundle({ a: "1" }, dek1);
  assert.throws(() => decryptSecretBundle(wire, dek2));
});

test("ciphertext doesn't leak plaintext bytes", () => {
  const dek = generateDek();
  const wire = encryptSecretBundle({ password: "p4ssw0rd!" }, dek);
  const decoded = Buffer.from(wire, "base64").toString("utf8");
  assert.equal(decoded.includes("p4ssw0rd"), false);
  assert.equal(decoded.includes("password"), false);
});
