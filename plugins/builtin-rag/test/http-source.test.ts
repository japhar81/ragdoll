/**
 * http_source — unit tests.
 *
 * The headline coverage is the SSRF guard. `ssrfReason()` is exported
 * precisely so the test surface covers each refused class explicitly —
 * dropping a row from the blocklist quietly is exactly the kind of
 * regression that's invisible until prod and devastating once it lands.
 *
 * The actual `execute()` path that does the live fetch is covered by
 * its URL-validation + scheme-validation + SSRF-reject branches —
 * we deliberately do NOT stand up a local HTTP server in the test
 * (the plugin has no fetch-injection seam and is straight `fetch()`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { httpSourcePlugin, ssrfReason } from "../src/http-source.ts";

// ---------------------------------------------------------------------------
// ssrfReason — refuse classes, accept classes
// ---------------------------------------------------------------------------

test("ssrfReason: public DNS name → null (allowed)", () => {
  assert.equal(ssrfReason("attack.mitre.org", false), null);
  assert.equal(ssrfReason("d3fend.mitre.org", false), null);
  assert.equal(ssrfReason("raw.githubusercontent.com", false), null);
});

test("ssrfReason: localhost is always refused, even with allowPrivateNetworks=true (load-bearing)", () => {
  // The whole point of the always-blocked list is that a tenant-
  // operator typo or a deliberate exfil attempt via `localhost`
  // can't slip through just because someone flipped the
  // allowPrivateNetworks flag for a different reason.
  assert.match(ssrfReason("localhost", false) ?? "", /always-blocked/);
  assert.match(ssrfReason("localhost", true) ?? "", /always-blocked/);
});

test("ssrfReason: cloud metadata literals are always refused", () => {
  for (const host of [
    "metadata.google.internal",
    "metadata",
    "169.254.169.254"
  ]) {
    const r = ssrfReason(host, true);
    assert.ok(r, `expected ${host} to be refused even with allowPrivateNetworks`);
  }
});

test("ssrfReason: literal RFC1918 IPv4 → refused by default, allowed with allowPrivateNetworks", () => {
  // 10/8
  assert.match(ssrfReason("10.0.0.1", false) ?? "", /private IPv4/);
  assert.equal(ssrfReason("10.0.0.1", true), null);
  // 192.168/16
  assert.match(ssrfReason("192.168.1.1", false) ?? "", /private IPv4/);
  assert.equal(ssrfReason("192.168.1.1", true), null);
  // 172.16-31/12 — boundary cases (15 + 32 are NOT in the range)
  assert.match(ssrfReason("172.16.0.1", false) ?? "", /private/);
  assert.match(ssrfReason("172.31.255.255", false) ?? "", /private/);
  assert.equal(ssrfReason("172.15.0.1", false), null);
  assert.equal(ssrfReason("172.32.0.1", false), null);
  // 127/8 (loopback) — refused even though it's not RFC1918.
  assert.match(ssrfReason("127.0.0.1", false) ?? "", /private/);
  // 169.254/16 (link-local + metadata) — refused.
  assert.match(ssrfReason("169.254.0.1", false) ?? "", /private/);
});

test("ssrfReason: 0.0.0.0 (unspecified) is refused — would bind to all interfaces", () => {
  assert.match(ssrfReason("0.0.0.0", false) ?? "", /private/);
});

test("ssrfReason: public IPv4 → null (allowed)", () => {
  assert.equal(ssrfReason("8.8.8.8", false), null);
  assert.equal(ssrfReason("1.1.1.1", false), null);
});

test("ssrfReason: IPv6 loopback + link-local + ULA are refused; with brackets too", () => {
  assert.match(ssrfReason("::1", false) ?? "", /private IPv6/);
  assert.match(ssrfReason("[::1]", false) ?? "", /private IPv6/);
  // link-local fe80::/10 — refused
  assert.match(ssrfReason("fe80::1", false) ?? "", /private IPv6/);
  // ULA fc00::/7 — refused
  assert.match(ssrfReason("fd00::1", false) ?? "", /private IPv6/);
  // Public-ish IPv6 (Google DNS) — allowed
  assert.equal(ssrfReason("2001:4860:4860::8888", false), null);
});

test("ssrfReason: .local and .internal suffixes refused (mDNS + AWS internal)", () => {
  assert.match(ssrfReason("server.local", false) ?? "", /private infra/);
  assert.match(ssrfReason("foo.internal", false) ?? "", /private infra/);
});

test("ssrfReason: case-insensitive", () => {
  // Defensive — operator pastes a mixed-case URL.
  assert.match(ssrfReason("LocalHost", false) ?? "", /always-blocked/);
  assert.match(ssrfReason("FE80::1", false) ?? "", /private IPv6/);
});

// ---------------------------------------------------------------------------
// execute() — pre-fetch validation branches (no live HTTP)
// ---------------------------------------------------------------------------

function execInput(config: Record<string, unknown>) {
  return {
    node: { id: "n", category: "datasource" },
    plugin: { id: "http_source", version: "1.0.0", category: "datasource" },
    config,
    inputs: {},
    secrets: {},
    dataset: { slug: "ds", bindings: {} },
    context: {
      executionId: "ex",
      tenantId: "t",
      environment: "dev",
      resolvedConfig: {
        pipelineId: "p",
        tenantId: "t",
        environment: "dev",
        violations: [],
        values: {}
      }
    }
  } as unknown as Parameters<typeof httpSourcePlugin.execute>[0];
}

test("http_source: missing config.url → actionable error", async () => {
  await assert.rejects(
    () => httpSourcePlugin.execute(execInput({})),
    /config\.url is required/
  );
});

test("http_source: malformed URL → loud error naming the value", async () => {
  await assert.rejects(
    () => httpSourcePlugin.execute(execInput({ url: "not a url at all" })),
    /not a valid URL/
  );
});

test("http_source: non-http(s) scheme refused (file://, ftp://, gopher://, data:)", async () => {
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.com/x",
    "gopher://example.com/0/",
    "data:text/plain;base64,aGVsbG8="
  ]) {
    await assert.rejects(
      () => httpSourcePlugin.execute(execInput({ url })),
      /scheme .* not supported/,
      `expected refusal for ${url}`
    );
  }
});

test("http_source: http(s) URL with private IP refused unless allowPrivateNetworks=true", async () => {
  await assert.rejects(
    () => httpSourcePlugin.execute(execInput({ url: "http://10.0.0.5/file.json" })),
    /refused.*private IPv4/
  );
});

test("http_source: cloud metadata URL refused even with allowPrivateNetworks=true (the override does NOT relax this)", async () => {
  await assert.rejects(
    () =>
      httpSourcePlugin.execute(
        execInput({
          url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
          allowPrivateNetworks: true
        })
      ),
    /refused.*always-blocked/
  );
});

test("http_source: localhost URL refused even with allowPrivateNetworks=true", async () => {
  await assert.rejects(
    () =>
      httpSourcePlugin.execute(
        execInput({ url: "http://localhost:8080/admin", allowPrivateNetworks: true })
      ),
    /refused.*always-blocked/
  );
});

// ---------------------------------------------------------------------------
// Manifest sanity
// ---------------------------------------------------------------------------

test("http_source: manifest is in the Sources palette group (no fallthrough to Other)", () => {
  assert.equal(httpSourcePlugin.manifest.ui?.paletteGroup, "Sources");
});

test("http_source: manifest declares the single `documents` output port (same shape as github_source for delta_filter wiring)", () => {
  const ports = httpSourcePlugin.manifest.outputPorts ?? [];
  assert.equal(ports.length, 1);
  assert.equal(ports[0].name, "documents");
});
