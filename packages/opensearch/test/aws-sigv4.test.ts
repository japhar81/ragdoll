/**
 * AWS SigV4 signing for the OpenSearch client.
 *
 * Correctness of the signature is cross-checked against `aws4` (mhart's
 * widely-used, dependency-free reference signer) across the request shapes the
 * client actually issues — GET, JSON POST, NDJSON `_bulk`, query params, and a
 * session token. `aws4` is a dev-only reference; the client itself signs with
 * `node:crypto` and ships no AWS dependency. Everything else (the credential
 * chain, caching, and client wiring) is exercised with injected env / fetch /
 * fs so no real AWS is touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import aws4 from "aws4";
import {
  signSigV4,
  createAwsCredentialsProvider,
  type AwsCredentials
} from "../src/aws-sigv4.ts";
import {
  OpenSearchClient,
  awsSigV4FromSecrets,
  awsSigV4FromConnectionOptions,
  mergeAwsSigV4,
  AWS_SIGV4_SECRET_FIELDS
} from "../src/client.ts";

const NOW = new Date("2026-08-04T12:34:56.000Z");
const AMZ_DATE = "20260804T123456Z";
const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

const CREDS: AwsCredentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
};

/** Sign the same request with our signer and with aws4; assert they agree. */
function crossCheck(args: {
  method: string;
  host: string;
  path: string;
  body?: string;
  service: string;
  region: string;
  contentType?: string;
  sessionToken?: string;
}): void {
  const creds: AwsCredentials = { ...CREDS, sessionToken: args.sessionToken };
  const url = `https://${args.host}${args.path}`;
  const mine = signSigV4({
    method: args.method,
    url,
    region: args.region,
    service: args.service,
    credentials: creds,
    body: args.body,
    contentType: args.contentType,
    now: NOW
  });

  // Pre-set X-Amz-Date + X-Amz-Content-Sha256 so aws4 signs the SAME header set
  // our signer always includes (content-sha256 is required for aoss).
  const headers: Record<string, string> = {
    "X-Amz-Date": AMZ_DATE,
    "X-Amz-Content-Sha256": sha256Hex(args.body ?? "")
  };
  if (args.contentType) headers["Content-Type"] = args.contentType;
  const req = {
    host: args.host,
    method: args.method,
    path: args.path,
    service: args.service,
    region: args.region,
    headers,
    body: args.body
  };
  aws4.sign(req, {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken
  });
  assert.equal(
    mine.headers.authorization,
    (req.headers as Record<string, string>).Authorization,
    "our Authorization must match aws4"
  );
}

test("signature matches aws4 — GET, no body (es)", () => {
  crossCheck({ method: "GET", host: "s.us-east-1.es.amazonaws.com", path: "/idx/_search", service: "es", region: "us-east-1" });
});

test("signature matches aws4 — JSON POST (es)", () => {
  crossCheck({
    method: "POST",
    host: "s.us-east-1.es.amazonaws.com",
    path: "/idx/_search",
    body: JSON.stringify({ query: { match_all: {} } }),
    service: "es",
    region: "us-east-1",
    contentType: "application/json"
  });
});

test("signature matches aws4 — NDJSON _bulk with query param (aoss)", () => {
  crossCheck({
    method: "POST",
    host: "abc.us-west-2.aoss.amazonaws.com",
    path: "/_bulk?refresh=true",
    body: '{"index":{"_index":"idx"}}\n{"a":1}\n',
    service: "aoss",
    region: "us-west-2",
    contentType: "application/x-ndjson"
  });
});

test("signature matches aws4 — multiple sorted query params", () => {
  crossCheck({
    method: "POST",
    host: "s.eu-west-1.es.amazonaws.com",
    path: "/idx/_delete_by_query?refresh=true&conflicts=proceed",
    body: "{}",
    service: "es",
    region: "eu-west-1",
    contentType: "application/json"
  });
});

test("signature matches aws4 — temporary credentials (session token)", () => {
  crossCheck({
    method: "GET",
    host: "abc.eu-west-1.aoss.amazonaws.com",
    path: "/idx/_mapping",
    service: "aoss",
    region: "eu-west-1",
    sessionToken: "FQoGZXIvYXdzEBY...EXAMPLE=="
  });
});

// --- invariants (no aws4) --------------------------------------------------

test("session token is added as x-amz-security-token and signed", () => {
  const r = signSigV4({
    method: "GET", url: "https://h.aoss.amazonaws.com/i/_search",
    region: "us-east-1", service: "aoss", credentials: { ...CREDS, sessionToken: "tok" }, now: NOW
  });
  assert.equal(r.headers["x-amz-security-token"], "tok");
  assert.match(r.headers.authorization, /x-amz-security-token/);
});

test("scope carries the date, region, and service", () => {
  const r = signSigV4({
    method: "GET", url: "https://h.aoss.amazonaws.com/i", region: "ap-south-1", service: "aoss", credentials: CREDS, now: NOW
  });
  assert.match(r.headers.authorization, /Credential=AKIDEXAMPLE\/20260804\/ap-south-1\/aoss\/aws4_request/);
  assert.match(r.headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
});

test("deterministic for identical inputs; different secret → different signature", () => {
  const base = { method: "GET" as const, url: "https://h/i", region: "us-east-1", service: "es", now: NOW };
  const a = signSigV4({ ...base, credentials: CREDS });
  const b = signSigV4({ ...base, credentials: CREDS });
  const c = signSigV4({ ...base, credentials: { ...CREDS, secretAccessKey: "different" } });
  assert.equal(a.signature, b.signature);
  assert.notEqual(a.signature, c.signature);
});

// --- credential chain ------------------------------------------------------

test("credentials: explicit config wins", async () => {
  const provider = createAwsCredentialsProvider({ region: "us-east-1", accessKeyId: "AKIA", secretAccessKey: "sk" });
  assert.deepEqual(await provider(), { accessKeyId: "AKIA", secretAccessKey: "sk", sessionToken: undefined });
});

test("credentials: standard AWS env vars", async () => {
  const provider = createAwsCredentialsProvider(
    { region: "us-east-1" },
    { env: { AWS_ACCESS_KEY_ID: "AKIAENV", AWS_SECRET_ACCESS_KEY: "envsk", AWS_SESSION_TOKEN: "envtok" } as NodeJS.ProcessEnv }
  );
  assert.deepEqual(await provider(), { accessKeyId: "AKIAENV", secretAccessKey: "envsk", sessionToken: "envtok" });
});

test("credentials: container endpoint (ECS / EKS Pod Identity)", async () => {
  let seenUrl = "";
  const provider = createAwsCredentialsProvider(
    { region: "us-east-1" },
    {
      env: { AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/creds", AWS_CONTAINER_AUTHORIZATION_TOKEN: "hdr-tok" } as NodeJS.ProcessEnv,
      fetchImpl: async (url) => {
        seenUrl = url;
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ AccessKeyId: "AKIACON", SecretAccessKey: "consk", Token: "contok", Expiration: "2099-01-01T00:00:00Z" })
        };
      }
    }
  );
  const creds = await provider();
  assert.equal(seenUrl, "http://169.254.170.23/creds");
  assert.equal(creds.accessKeyId, "AKIACON");
  assert.equal(creds.sessionToken, "contok");
});

test("credentials: IRSA web-identity via STS", async () => {
  let stsBody = "";
  const provider = createAwsCredentialsProvider(
    { region: "us-east-1" },
    {
      env: { AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/token", AWS_ROLE_ARN: "arn:aws:iam::123:role/r" } as NodeJS.ProcessEnv,
      readFile: async () => "the.jwt.token",
      fetchImpl: async (url, init) => {
        assert.match(url, /sts\.us-east-1\.amazonaws\.com/);
        stsBody = init?.body ?? "";
        return {
          ok: true, status: 200,
          text: async () =>
            "<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials>" +
            "<AccessKeyId>AKIAWEB</AccessKeyId><SecretAccessKey>websk</SecretAccessKey>" +
            "<SessionToken>webtok</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration>" +
            "</Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>"
        };
      }
    }
  );
  const creds = await provider();
  assert.match(stsBody, /Action=AssumeRoleWithWebIdentity/);
  assert.match(stsBody, /WebIdentityToken=the.jwt.token/);
  assert.equal(creds.accessKeyId, "AKIAWEB");
  assert.equal(creds.secretAccessKey, "websk");
  assert.equal(creds.sessionToken, "webtok");
});

test("credentials: unresolvable chain throws an actionable error", async () => {
  const provider = createAwsCredentialsProvider({ region: "us-east-1" }, { env: {} as NodeJS.ProcessEnv });
  await assert.rejects(() => provider(), /could not resolve credentials/);
});

test("credentials: temporary creds are cached, then refreshed near expiry", async () => {
  let calls = 0;
  const provider = createAwsCredentialsProvider({
    region: "us-east-1",
    credentialsProvider: async () => {
      calls += 1;
      // First call: already-expired; second: long-lived.
      return calls === 1
        ? { accessKeyId: "A1", secretAccessKey: "s", expiration: Date.now() - 1000 }
        : { accessKeyId: "A2", secretAccessKey: "s", expiration: Date.now() + 3_600_000 };
    }
  });
  assert.equal((await provider()).accessKeyId, "A1"); // resolved
  assert.equal((await provider()).accessKeyId, "A2"); // expired → re-resolved
  assert.equal((await provider()).accessKeyId, "A2"); // fresh → cached
  assert.equal(calls, 2);
});

// --- client integration ----------------------------------------------------

test("OpenSearchClient signs every request when aws config is set", async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const client = new OpenSearchClient({
    endpoint: "https://abc.us-east-1.aoss.amazonaws.com",
    aws: { region: "us-east-1", service: "aoss", accessKeyId: "AKIA", secretAccessKey: "sk" },
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: init?.headers ?? {} });
      return { ok: true, status: 200, text: async () => JSON.stringify({ hits: { total: { value: 0 }, hits: [] } }) };
    }
  });
  await client.search("idx", { query: { match_all: {} } });
  assert.equal(seen.length, 1);
  const h = seen[0].headers;
  assert.match(h.authorization ?? "", /^AWS4-HMAC-SHA256 Credential=AKIA\/\d{8}\/us-east-1\/aoss\/aws4_request/);
  assert.ok(h["x-amz-date"], "x-amz-date present");
  assert.ok(h["x-amz-content-sha256"], "x-amz-content-sha256 present");
  // No basic-auth header when signing.
  assert.equal(h.authorization?.startsWith("Basic"), false);
});

// --- secret-map mapping + schema fragment ---------------------------------

test("awsSigV4FromSecrets: enabled by awsRegion / awsService / awsSigv4; maps the fields", () => {
  assert.deepEqual(
    awsSigV4FromSecrets({
      awsRegion: "us-east-1",
      awsService: "aoss",
      awsAccessKeyId: "AKIA",
      awsSecretAccessKey: "sk",
      awsSessionToken: "tok"
    }),
    { region: "us-east-1", service: "aoss", accessKeyId: "AKIA", secretAccessKey: "sk", sessionToken: "tok" }
  );
  // Region alone (IRSA) is enough to enable — credentials fall through to the role.
  assert.equal(awsSigV4FromSecrets({ awsRegion: "eu-west-1" })?.region, "eu-west-1");
  assert.equal(awsSigV4FromSecrets({ awsSigv4: "true" }) !== undefined, true);
});

test("awsSigV4FromSecrets: absent when no AWS field is set (basic-auth path)", () => {
  assert.equal(awsSigV4FromSecrets({ username: "u", password: "p" }), undefined);
  assert.equal(awsSigV4FromSecrets({}), undefined);
});

test("AWS_SIGV4_SECRET_FIELDS covers exactly the field names the mapper reads", () => {
  assert.deepEqual(
    Object.keys(AWS_SIGV4_SECRET_FIELDS).sort(),
    ["awsAccessKeyId", "awsRegion", "awsSecretAccessKey", "awsService", "awsSessionToken"]
  );
  for (const f of Object.values(AWS_SIGV4_SECRET_FIELDS)) {
    assert.equal(f.format, "secret-ref"); // so the Builder renders a secret-ref input
  }
});

// --- AWS OpenSearch Serverless request-shape (refresh) --------------------

function captureUrls(): { urls: string[]; fetchImpl: (u: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }> } {
  const urls: string[] = [];
  return {
    urls,
    fetchImpl: async (u: string) => {
      urls.push(u);
      return { ok: true, status: 200, text: async () => JSON.stringify({ errors: false, items: [] }) };
    }
  };
}

test("aoss: bulkIndex omits the refresh param (Serverless rejects it)", async () => {
  const cap = captureUrls();
  const client = new OpenSearchClient({
    endpoint: "https://abc.us-east-1.aoss.amazonaws.com",
    aws: { region: "us-east-1", service: "aoss", accessKeyId: "A", secretAccessKey: "s" },
    fetchImpl: cap.fetchImpl as never
  });
  await client.bulkIndex("idx", [{ doc: { a: 1 } }], /* refresh */ true);
  const bulk = cap.urls.find((u) => u.includes("/_bulk"));
  assert.ok(bulk && !bulk.includes("refresh"), `aoss _bulk must not carry refresh: ${bulk}`);
});

test("managed domain (es): bulkIndex keeps refresh=true", async () => {
  const cap = captureUrls();
  const client = new OpenSearchClient({
    endpoint: "https://s.us-east-1.es.amazonaws.com",
    aws: { region: "us-east-1", service: "es", accessKeyId: "A", secretAccessKey: "s" },
    fetchImpl: cap.fetchImpl as never
  });
  await client.bulkIndex("idx", [{ doc: { a: 1 } }], true);
  assert.ok(cap.urls.some((u) => u.includes("/_bulk?refresh=true")));
});

test("aoss: deleteByQuery drops refresh but keeps conflicts=proceed", async () => {
  const cap = captureUrls();
  const client = new OpenSearchClient({
    endpoint: "https://abc.us-east-1.aoss.amazonaws.com",
    aws: { region: "us-east-1", service: "aoss", accessKeyId: "A", secretAccessKey: "s" },
    fetchImpl: cap.fetchImpl as never
  });
  await client.deleteByQuery("idx", { match_all: {} });
  const del = cap.urls.find((u) => u.includes("_delete_by_query"));
  assert.ok(del && !del.includes("refresh") && del.includes("conflicts=proceed"), del);
});

// --- AWS config from the connection options + merge -----------------------

test("awsSigV4FromConnectionOptions: reads region/service from the connection config", () => {
  assert.deepEqual(
    awsSigV4FromConnectionOptions({ awsRegion: "us-east-1", awsService: "aoss", host: "x", port: 443 }),
    { region: "us-east-1", service: "aoss", accessKeyId: undefined, secretAccessKey: undefined, sessionToken: undefined }
  );
  assert.equal(awsSigV4FromConnectionOptions({ host: "x" }), undefined);
  assert.equal(awsSigV4FromConnectionOptions(undefined), undefined);
});

test("mergeAwsSigV4: node secrets override the connection config field-by-field", () => {
  const fromConn = { region: "us-east-1", service: "aoss", accessKeyId: "conn-key" } as never;
  const fromSecrets = { region: undefined, service: "aoss", accessKeyId: "secret-key" } as never;
  // secrets win where set (accessKeyId); connection fills where secrets are undefined (region).
  assert.deepEqual(mergeAwsSigV4(fromConn, fromSecrets), {
    region: "us-east-1",
    service: "aoss",
    accessKeyId: "secret-key"
  });
  assert.equal(mergeAwsSigV4(undefined, undefined), undefined);
});

test("OpenSearchClient without aws still uses basic auth (unchanged)", async () => {
  let authHeader = "";
  const client = new OpenSearchClient({
    endpoint: "http://opensearch:9200",
    auth: { username: "admin", password: "pw" },
    fetchImpl: async (_url, init) => {
      authHeader = init?.headers?.authorization ?? "";
      return { ok: true, status: 200, text: async () => "{}" };
    }
  });
  await client.indexExists("idx");
  assert.match(authHeader, /^Basic /);
});
