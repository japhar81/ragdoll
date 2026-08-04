/**
 * AWS Signature Version 4 signing for the OpenSearch client — needed for AWS
 * OpenSearch Serverless (`aoss`) and IAM-secured managed domains (`es`).
 *
 * Deliberately dependency-free, like the client it serves: the signing
 * algorithm is `node:crypto` HMAC, and every credential source (static keys,
 * env vars, the ECS/EKS-Pod-Identity container endpoint, and IRSA web-identity
 * via STS) is resolved with `fetch` + `node:fs`. No `@aws-sdk/*`.
 *
 * The one piece we do NOT hand-roll is an arbitrary provider chain (SSO,
 * config-file profiles, assume-role trees) — those are the AWS SDK's job.
 * `credentialsProvider` is the injection point: pass e.g.
 * `fromNodeProviderChain()` from `@aws-sdk/credential-providers` and it wins.
 */

import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";

const sha256Hex = (data: string): string =>
  createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

/** `YYYYMMDDTHHMMSSZ` + the `YYYYMMDD` date stamp SigV4 wants. */
function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:-]/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/** encodeURIComponent leaves `!*'()` unescaped; RFC 3986 (what SigV4 wants)
 *  does not. */
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present for temporary credentials (STS / IRSA / Pod Identity). */
  sessionToken?: string;
  /** Epoch-ms expiry for temporary credentials; undefined = non-expiring. */
  expiration?: number;
}

/** Resolves (and refreshes) credentials on demand. */
export type AwsCredentialsProvider = () => Promise<AwsCredentials>;

export interface SigV4SignArgs {
  method: string;
  /** Full request URL (`https://host/path?query`). */
  url: string;
  region: string;
  /** `aoss` for OpenSearch Serverless, `es` for a managed domain. */
  service: string;
  credentials: AwsCredentials;
  /** Request body exactly as sent (JSON string, NDJSON, or undefined). */
  body?: string;
  /** Content-Type header sent with the request; signed when present. */
  contentType?: string;
  /** Injectable clock (tests). */
  now?: Date;
}

export interface SigV4Result {
  /** Headers to ADD to the outgoing request (Host is set by fetch, not here). */
  headers: Record<string, string>;
  /** Exposed for tests to assert against reference vectors. */
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

/**
 * Compute the SigV4 signature for a request. Always signs `host`,
 * `x-amz-content-sha256`, and `x-amz-date` (the set OpenSearch Serverless
 * requires), plus `content-type` and `x-amz-security-token` when present.
 */
export function signSigV4(args: SigV4SignArgs): SigV4Result {
  const u = new URL(args.url);
  const { amzDate, dateStamp } = amzDates(args.now ?? new Date());
  const payloadHash = sha256Hex(args.body ?? "");

  // Headers included in the signature. Keys are already lowercase. `host`,
  // `content-length`, and `content-type` are set by fetch (not returned below),
  // so we sign the values fetch will actually send: a string body's
  // Content-Length is deterministically its UTF-8 byte length.
  const signed: Record<string, string> = {
    host: u.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate
  };
  if (args.body !== undefined) {
    signed["content-length"] = String(Buffer.byteLength(args.body, "utf8"));
  }
  if (args.contentType) signed["content-type"] = args.contentType;
  if (args.credentials.sessionToken) {
    signed["x-amz-security-token"] = args.credentials.sessionToken;
  }

  const names = Object.keys(signed).sort();
  const canonicalHeaders = names
    .map((n) => `${n}:${signed[n].trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");

  const canonicalQuery = [...u.searchParams.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join("&");

  const canonicalRequest = [
    args.method.toUpperCase(),
    u.pathname || "/",
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");

  const scope = `${dateStamp}/${args.region}/${args.service}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    sha256Hex(canonicalRequest)
  ].join("\n");

  const kDate = hmac(`AWS4${args.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, args.region);
  const kService = hmac(kRegion, args.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization =
    `${ALGORITHM} Credential=${args.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: Record<string, string> = {
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    authorization
  };
  if (args.contentType) headers["content-type"] = args.contentType;
  if (args.credentials.sessionToken) {
    headers["x-amz-security-token"] = args.credentials.sessionToken;
  }
  return { headers, canonicalRequest, stringToSign, signature };
}

// ---------------------------------------------------------------------------
// Credential resolution — static → env → container endpoint → web identity.
// ---------------------------------------------------------------------------

export interface AwsSigV4Config {
  region?: string;
  /** `aoss` (Serverless) or `es` (managed domain). Default `es`. */
  service?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** Escape hatch for the full AWS SDK provider chain (SSO, profiles, …). */
  credentialsProvider?: AwsCredentialsProvider;
}

/** Injectable environment for testing the credential chain without AWS. */
export interface CredentialResolverDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string }
  ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  readFile?: (path: string) => Promise<string>;
}

const pick = (xml: string, tag: string): string | undefined =>
  xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];

/**
 * Build a caching credentials provider. Resolves once, then reuses the value
 * until ~1 min before expiry (temporary creds), re-resolving transparently.
 * Resolution order: explicit config → standard AWS_* env vars → the
 * ECS/EKS-Pod-Identity container endpoint → IRSA web-identity via STS. An
 * injected `credentialsProvider` short-circuits the whole chain.
 */
export function createAwsCredentialsProvider(
  config: AwsSigV4Config,
  deps: CredentialResolverDeps = {}
): AwsCredentialsProvider {
  const env = deps.env ?? process.env;
  const resolveOnce: AwsCredentialsProvider =
    config.credentialsProvider ?? (() => resolveDefault(config, env, deps));

  let cached: AwsCredentials | undefined;
  return async () => {
    const now = Date.now();
    if (cached && (cached.expiration === undefined || cached.expiration - 60_000 > now)) {
      return cached;
    }
    cached = await resolveOnce();
    return cached;
  };
}

async function resolveDefault(
  config: AwsSigV4Config,
  env: NodeJS.ProcessEnv,
  deps: CredentialResolverDeps
): Promise<AwsCredentials> {
  // 1. Explicit config.
  if (config.accessKeyId && config.secretAccessKey) {
    return {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken
    };
  }
  // 2. Standard environment variables (static keys or assumed-role exports).
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN
    };
  }
  // 3. Container credentials endpoint (ECS task role / EKS Pod Identity).
  if (env.AWS_CONTAINER_CREDENTIALS_FULL_URI || env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) {
    return fromContainerEndpoint(env, deps);
  }
  // 4. Web identity (IRSA on EKS).
  if (env.AWS_WEB_IDENTITY_TOKEN_FILE && env.AWS_ROLE_ARN) {
    return fromWebIdentity(config, env, deps);
  }
  throw new Error(
    "AWS SigV4: could not resolve credentials — set accessKeyId/secretAccessKey, " +
      "the AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY env vars, run in an AWS " +
      "environment (ECS/EKS Pod Identity or IRSA), or inject a credentialsProvider."
  );
}

async function fromContainerEndpoint(
  env: NodeJS.ProcessEnv,
  deps: CredentialResolverDeps
): Promise<AwsCredentials> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as CredentialResolverDeps["fetchImpl"]);
  if (!fetchImpl) throw new Error("AWS SigV4: no fetch available for the container credentials endpoint");
  const url =
    env.AWS_CONTAINER_CREDENTIALS_FULL_URI ??
    `http://169.254.170.2${env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}`;
  const headers: Record<string, string> = {};
  const tokenFile = env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE;
  if (tokenFile && deps.readFile) headers.Authorization = (await deps.readFile(tokenFile)).trim();
  else if (env.AWS_CONTAINER_AUTHORIZATION_TOKEN) headers.Authorization = env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
  const res = await fetchImpl(url, { headers });
  const json = JSON.parse(await res.text()) as {
    AccessKeyId: string;
    SecretAccessKey: string;
    Token?: string;
    Expiration?: string;
  };
  if (!res.ok || !json.AccessKeyId) {
    throw new Error(`AWS SigV4: container credentials endpoint returned HTTP ${res.status}`);
  }
  return {
    accessKeyId: json.AccessKeyId,
    secretAccessKey: json.SecretAccessKey,
    sessionToken: json.Token,
    expiration: json.Expiration ? Date.parse(json.Expiration) : undefined
  };
}

async function fromWebIdentity(
  config: AwsSigV4Config,
  env: NodeJS.ProcessEnv,
  deps: CredentialResolverDeps
): Promise<AwsCredentials> {
  const region = config.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  if (!region) throw new Error("AWS SigV4: region is required for IRSA web-identity");
  const readFile = deps.readFile;
  if (!readFile) throw new Error("AWS SigV4: no readFile available for the web-identity token");
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as CredentialResolverDeps["fetchImpl"]);
  if (!fetchImpl) throw new Error("AWS SigV4: no fetch available for STS");
  const token = (await readFile(env.AWS_WEB_IDENTITY_TOKEN_FILE as string)).trim();
  const params = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: env.AWS_ROLE_ARN as string,
    RoleSessionName: env.AWS_ROLE_SESSION_NAME ?? "ragdoll-opensearch",
    WebIdentityToken: token
  });
  // Web-identity assume-role is itself UNSIGNED (the JWT is the credential).
  const res = await fetchImpl(`https://sts.${region}.amazonaws.com/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  const xml = await res.text();
  if (!res.ok) throw new Error(`AWS SigV4: STS AssumeRoleWithWebIdentity returned HTTP ${res.status}: ${xml.slice(0, 200)}`);
  const accessKeyId = pick(xml, "AccessKeyId");
  const secretAccessKey = pick(xml, "SecretAccessKey");
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("AWS SigV4: STS response missing credentials");
  }
  const exp = pick(xml, "Expiration");
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: pick(xml, "SessionToken"),
    expiration: exp ? Date.parse(exp) : undefined
  };
}
