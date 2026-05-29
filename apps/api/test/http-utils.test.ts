/**
 * Pure tests for apps/api/src/app/http-utils.ts. Focused on `clientIp` since
 * X-Forwarded-For parsing just bit us in prod — OpenShift's HAProxy router
 * appends the LB hop to the header, producing `<client>, <hop1>` which broke
 * the Postgres `inet` column on audit_logs and surfaced as a 400
 * `invalid_identifier` AFTER the pipeline had already enqueued.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { clientIp, headerValue } from "../src/app/http-utils.ts";

test("clientIp: single IP in X-Forwarded-For", () => {
  assert.equal(clientIp({ "x-forwarded-for": "203.0.113.5" }), "203.0.113.5");
});

test("clientIp: comma-separated XFF returns leftmost client IP", () => {
  // The exact shape that broke us on OpenShift: HAProxy router appends
  // its own pod IP after the original client.
  assert.equal(
    clientIp({ "x-forwarded-for": "24.27.107.143, 10.128.64.15" }),
    "24.27.107.143"
  );
});

test("clientIp: multi-hop XFF still returns leftmost", () => {
  assert.equal(
    clientIp({
      "x-forwarded-for": "198.51.100.7, 192.0.2.1, 10.0.0.1, 10.0.0.2"
    }),
    "198.51.100.7"
  );
});

test("clientIp: strips surrounding whitespace", () => {
  assert.equal(
    clientIp({ "x-forwarded-for": "  203.0.113.5  ,10.0.0.1" }),
    "203.0.113.5"
  );
});

test("clientIp: IPv6 passes through", () => {
  assert.equal(
    clientIp({ "x-forwarded-for": "2001:db8::1, 10.0.0.1" }),
    "2001:db8::1"
  );
});

test("clientIp: falls back to X-Real-IP when XFF is missing", () => {
  assert.equal(clientIp({ "x-real-ip": "203.0.113.99" }), "203.0.113.99");
});

test("clientIp: empty XFF falls back to X-Real-IP", () => {
  // Some buggy proxies set XFF to empty string; we should not return ""
  // because Postgres `inet` rejects empty strings.
  assert.equal(
    clientIp({ "x-forwarded-for": "", "x-real-ip": "203.0.113.99" }),
    "203.0.113.99"
  );
});

test("clientIp: undefined when neither header present", () => {
  assert.equal(clientIp({}), undefined);
});

test("clientIp: undefined when only blank values present", () => {
  // Must NOT return "" — that would be rejected by Postgres inet.
  assert.equal(
    clientIp({ "x-forwarded-for": "   ", "x-real-ip": "" }),
    undefined
  );
});

test("clientIp: handles array-valued header (Node coerces dup'd headers)", () => {
  // headerValue takes the first array element; that should then be
  // split on `,` and trimmed exactly like a string-valued header.
  assert.equal(
    clientIp({ "x-forwarded-for": ["203.0.113.5, 10.0.0.1", "other"] }),
    "203.0.113.5"
  );
});

test("headerValue: returns first element when header is an array", () => {
  // Node's parser lowercases header names; arrays appear when a header is
  // repeated. We pick the first as the canonical value.
  assert.equal(
    headerValue({ "x-request-id": ["abc", "def"] }, "x-request-id"),
    "abc"
  );
});
