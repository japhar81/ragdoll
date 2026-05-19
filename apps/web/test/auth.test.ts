import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeToken,
  isExpired,
  readTokenFromHash,
  loadToken,
  saveToken,
  clearToken
} from "../src/lib/auth.ts";

function mkToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
}

// ---- decodeToken ----------------------------------------------------------

test("decodeToken reads the unverified payload", () => {
  const t = mkToken({ sub: "u1", type: "user", exp: 999 });
  assert.deepEqual(decodeToken(t), { sub: "u1", type: "user", exp: 999 });
});

test("decodeToken rejects malformed input", () => {
  assert.equal(decodeToken(null), null);
  assert.equal(decodeToken(""), null);
  assert.equal(decodeToken("a.b"), null);
  assert.equal(decodeToken("a.b.c"), null); // non-JSON payload
  assert.equal(decodeToken(mkToken({ noSub: true })), null);
});

// ---- isExpired ------------------------------------------------------------

test("isExpired honours the exp claim", () => {
  const now = 1_000_000;
  assert.equal(isExpired(mkToken({ sub: "u", exp: 999 }), now * 1000), true);
  assert.equal(
    isExpired(mkToken({ sub: "u", exp: now + 60 }), now * 1000),
    false
  );
  // No exp => treated as non-expiring (server still enforces).
  assert.equal(isExpired(mkToken({ sub: "u" })), false);
  // Junk => expired.
  assert.equal(isExpired("garbage"), true);
});

// ---- readTokenFromHash ----------------------------------------------------

test("readTokenFromHash extracts the SSO access_token", () => {
  assert.equal(
    readTokenFromHash("#access_token=abc.def.ghi"),
    "abc.def.ghi"
  );
  assert.equal(
    readTokenFromHash("access_token=xyz&state=1"),
    "xyz"
  );
  assert.equal(readTokenFromHash("#other=1"), undefined);
  assert.equal(readTokenFromHash(""), undefined);
  assert.equal(readTokenFromHash(undefined), undefined);
});

// ---- storage (injected, no DOM) ------------------------------------------

test("save/load/clear round-trips through injected storage", () => {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k)
  };
  const fresh = mkToken({ sub: "u", exp: Math.floor(Date.now() / 1000) + 999 });
  saveToken(fresh, store);
  assert.equal(loadToken(store), fresh);

  // An expired stored token is not returned.
  saveToken(mkToken({ sub: "u", exp: 1 }), store);
  assert.equal(loadToken(store), undefined);

  clearToken(store);
  assert.equal(loadToken(store), undefined);
});
