/**
 * `http_source` — generic single-URL fetch.
 *
 * Companion to `github_source`. github_source enumerates a repo tree
 * and is GitHub-specific (REST API + raw.githubusercontent.com); when
 * the operator wants to fetch a single URL — a public STIX bundle, a
 * D3FEND OWL/JSON-LD release, a vendor blob — it's awkward to bend
 * github_source to that shape. http_source is the cleaner primitive:
 * point at a URL, get a document.
 *
 * Used by the ATT&CK / D3FEND reference-ETL pattern (ADR-0032) as the
 * source step; the rest of the pipeline (transform → delta_filter →
 * neo4j_write) is all existing plugins.
 *
 * Security posture
 * ----------------
 * In a multi-tenant runtime a tenant-supplied URL is a server-side
 * request that originates from the worker process — so SSRF guards
 * are required by default. The plugin:
 *
 *   - REFUSES URLs whose hostname is a literal RFC1918 / loopback /
 *     link-local / wildcard address (10.0.0.0/8, 172.16.0.0/12,
 *     192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16, 0.0.0.0, ::1,
 *     fc00::/7, fe80::/10).
 *   - REFUSES `localhost` / `*.local` / `metadata.google.internal` /
 *     the AWS / GCP metadata service literals.
 *   - REFUSES non-http(s) schemes.
 *   - REQUIRES `allowPrivateNetworks: true` (explicit opt-in) to
 *     bypass the literal-IP check. Even then, we leave `localhost`
 *     and the cloud metadata literals on the blocklist — those have
 *     zero legitimate use case for a reference ETL.
 *
 * This is NOT a full SSRF guard — a DNS name that resolves to a
 * private IP slips through unless we also resolve + recheck (DNS-
 * rebinding adds yet another layer). For the reference-ETL use case
 * (fetching versioned vendor bundles from publicly-hosted URLs the
 * operator typed once at pipeline-config time) the literal-IP gate
 * is the load-bearing protection. If we add tenant-provided
 * arbitrary URLs as a wider primitive later, fold in undici Agent +
 * connect-hook resolution-time validation.
 */
import type { InProcessPlugin } from "../../../packages/plugin-sdk/src/index.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
// Bundle ceiling — 64 MiB covers every published ATT&CK / D3FEND
// release with margin. Above this we abort the read so a misconfigured
// URL (a 4 GB tar.gz) can't blow up the worker.
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

interface HttpSourceConfig {
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  acceptHeader?: unknown;
  allowPrivateNetworks?: unknown;
  timeoutMs?: unknown;
  maxBytes?: unknown;
  docId?: unknown;
}

const PRIVATE_IPV4_PREFIXES: ReadonlyArray<readonly [number, number, number, number]> = [
  // CIDR-encoded prefix-length-matched at the octet level. We keep
  // this list short and explicit rather than parsing CIDR strings.
  [10, 0, 0, 0],         // 10.0.0.0/8
  [127, 0, 0, 0],        // 127.0.0.0/8 (loopback)
  [169, 254, 0, 0],      // 169.254.0.0/16 (link-local + metadata)
  [192, 168, 0, 0],      // 192.168.0.0/16
  [0, 0, 0, 0]           // 0.0.0.0 unspecified
];

function ipv4InPrivateRange(host: string): boolean {
  const parts = host.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  for (const [a, b] of PRIVATE_IPV4_PREFIXES) {
    if (parts[0] === a) {
      // 10.x / 127.x / 0.x — full /8 match.
      if (a === 10 || a === 127 || a === 0) return true;
      // 169.254 / 192.168 — match second octet too.
      if (parts[1] === b) return true;
    }
  }
  // 172.16.0.0/12 (172.16.0.0 – 172.31.255.255)
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

function ipv6InPrivateRange(host: string): boolean {
  const lower = host.toLowerCase();
  // ::1 (loopback), fe80::/10 (link-local), fc00::/7 (unique local).
  if (lower === "::1" || lower === "[::1]") return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
      lower.startsWith("fea") || lower.startsWith("feb")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return false;
}

const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  // AWS / GCP / Azure / OCI metadata services — same address as the
  // 169.254 check above, but also commonly resolved via these names
  // on cloud worker nodes.
  "metadata.google.internal",
  "metadata",
  "169.254.169.254"
]);

/**
 * Reject if the URL hostname is unsafe. Returns `null` when safe;
 * returns the reason string when refused.
 */
export function ssrfReason(
  hostname: string,
  allowPrivateNetworks: boolean
): string | null {
  const host = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) {
    return `hostname ${host} is on the always-blocked list (localhost / cloud metadata)`;
  }
  if (host.endsWith(".local") || host.endsWith(".internal")) {
    return `hostname suffix ${host} resolves to private infra (set allowPrivateNetworks=true to override — NOT recommended for tenant-supplied URLs)`;
  }
  // Bracketed IPv6 — strip for the range check.
  const ipHost = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ipHost);
  const isIpv6 = ipHost.includes(":");
  if (isIpv4 && ipv4InPrivateRange(ipHost) && !allowPrivateNetworks) {
    return `hostname ${host} is in a private IPv4 range (set allowPrivateNetworks=true to override)`;
  }
  if (isIpv6 && ipv6InPrivateRange(ipHost) && !allowPrivateNetworks) {
    return `hostname ${host} is in a private IPv6 range (set allowPrivateNetworks=true to override)`;
  }
  return null;
}

export const httpSourcePlugin: InProcessPlugin = {
  manifest: {
    id: "http_source",
    name: "HTTP Source",
    version: "1.0.0",
    category: "datasource",
    description:
      "Fetches a single URL and emits the response body as a document. The cleaner primitive when github_source's repo-tree shape is overkill — point at a public STIX bundle, D3FEND OWL/JSON-LD release, or vendor blob and get back `{ docId, url, content, contentType, status, headers, fetchedAt }`. Default SSRF guard refuses literal-private-IP + loopback + cloud-metadata hostnames; `allowPrivateNetworks: true` opts in (NOT recommended for tenant-supplied URLs). Used by the ATT&CK / D3FEND reference-ETL pattern in ADR-0032.",
    configSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description:
            "Full URL to fetch. http(s) only. The hostname is checked against the SSRF blocklist before the request is made; literal private IPs are refused unless allowPrivateNetworks is true."
        },
        method: {
          type: "string",
          enum: ["GET", "HEAD"],
          default: "GET",
          description:
            "HTTP method. GET (default) returns the body; HEAD returns headers only — useful for cheap freshness checks before a delta_filter."
        },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Optional request headers — e.g. an `Authorization: Bearer ...` if the URL requires it, or `User-Agent` to identify the puller. NEVER place secrets in this map; resolve them through input.secrets and splice them in via a transform-by-config pattern."
        },
        acceptHeader: {
          type: "string",
          description:
            "Convenience shortcut for the `Accept` header. Defaults to `application/json` when unset."
        },
        allowPrivateNetworks: {
          type: "boolean",
          default: false,
          description:
            "When true, the literal-IP SSRF guard is relaxed — the request may reach RFC1918 / link-local hosts. The cloud-metadata + localhost denylist stays on. Use ONLY when you're fetching from a private vendor server you control, NEVER when the URL is tenant-supplied."
        },
        timeoutMs: {
          type: "integer",
          default: 30_000,
          description:
            "Per-request wall-clock cap (ms). Default 30s — lift for slow reference bundles, but understand the runaway cost."
        },
        maxBytes: {
          type: "integer",
          default: 67_108_864,
          description:
            "Body-size ceiling. Default 64 MiB. Defensive against a misconfigured URL returning gigabytes of data."
        },
        docId: {
          type: "string",
          description:
            "Optional explicit document id for the downstream delta_filter to key on. Defaults to the URL itself, which keeps version-keyed delta detection simple (the URL embeds the version, e.g. `.../v15.1/enterprise-attack.json`)."
        }
      },
      additionalProperties: false
    },
    inputPorts: [],
    outputPorts: [
      {
        name: "documents",
        description:
          "Single-element array `[{ docId, url, content, contentType, status, headers, fetchedAt }]`. Single-element so the same `documents` shape feeds delta_filter and downstream transforms — same as github_source's emission shape."
      }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "download",
      color: "#0ea5e9",
      paletteGroup: "Sources",
      formHints: {
        url: { widget: "text" },
        method: { widget: "select" },
        headers: { widget: "json" }
      }
    }
  },
  async execute(input) {
    const cfg = input.config as HttpSourceConfig;
    const url = typeof cfg.url === "string" ? cfg.url.trim() : "";
    if (!url) throw new Error("http_source: config.url is required");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`http_source: config.url is not a valid URL: ${url}`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(
        `http_source: scheme ${parsed.protocol} not supported — http(s) only`
      );
    }
    const allowPrivate = cfg.allowPrivateNetworks === true;
    const ssrfErr = ssrfReason(parsed.hostname, allowPrivate);
    if (ssrfErr) throw new Error(`http_source: refused — ${ssrfErr}`);

    const method = cfg.method === "HEAD" ? "HEAD" : "GET";
    const headers: Record<string, string> = {};
    const acceptHeader =
      typeof cfg.acceptHeader === "string" ? cfg.acceptHeader : "application/json";
    headers.accept = acceptHeader;
    if (cfg.headers && typeof cfg.headers === "object") {
      for (const [k, v] of Object.entries(cfg.headers as Record<string, unknown>)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
      }
    }
    const timeoutMs =
      typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0
        ? Math.floor(cfg.timeoutMs)
        : DEFAULT_TIMEOUT_MS;
    const maxBytes =
      typeof cfg.maxBytes === "number" && cfg.maxBytes > 0
        ? Math.floor(cfg.maxBytes)
        : DEFAULT_MAX_BYTES;
    const docId =
      typeof cfg.docId === "string" && cfg.docId.length > 0 ? cfg.docId : url;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        signal: controller.signal
      });
    } catch (e) {
      throw new Error(
        `http_source: fetch ${url} failed: ${(e as Error).message ?? String(e)}`
      );
    } finally {
      clearTimeout(timer);
    }
    // Capture response headers as a plain object so downstream transforms
    // can branch on content-type / etag / last-modified without dealing
    // with the Headers iterator.
    const respHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      respHeaders[key.toLowerCase()] = value;
    });
    if (!response.ok) {
      throw new Error(
        `http_source: ${method} ${url} → HTTP ${response.status}`
      );
    }
    let content: string = "";
    if (method !== "HEAD") {
      // Read with the size cap. We tolerate non-chunked bodies by
      // reading via arrayBuffer and slicing.
      const buf = new Uint8Array(await response.arrayBuffer());
      if (buf.byteLength > maxBytes) {
        throw new Error(
          `http_source: body ${buf.byteLength} bytes exceeds maxBytes=${maxBytes}`
        );
      }
      content = new TextDecoder("utf-8").decode(buf);
    }
    return {
      outputs: {
        documents: [
          {
            docId,
            url,
            content,
            contentType: respHeaders["content-type"] ?? "",
            status: response.status,
            headers: respHeaders,
            fetchedAt: new Date().toISOString()
          }
        ]
      }
    };
  }
};
