/**
 * Webhook trigger tokens. Mirrors {@link ApiKeyService} but for the public
 * `POST /api/triggers/webhook/:token` endpoint, so its tokens cannot be
 * confused with API keys when one leaks into a log.
 *
 *   Format:   `wht_<prefix>_<secret>`
 *   Stored:   sha256(plaintext) hex + a 12-char prefix for O(1) lookup
 *   Compare:  constant-time
 *
 * "Verify" returns the bound (tenantId, pipelineId, environment, activation)
 * the caller can hand to the queue without re-querying.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export class InvalidWebhookTokenError extends Error {
  constructor(message = "Invalid webhook token") {
    super(message);
    this.name = "InvalidWebhookTokenError";
  }
}

export interface WebhookTokenRecord {
  id: string;
  prefix: string;
  hash: string;
  enabled: boolean;
  revokedAt?: string | null;
}

export interface WebhookTokenStore {
  /** Persist a freshly minted record (the prefix is unique). */
  create(input: {
    id: string;
    prefix: string;
    hash: string;
  }): Promise<unknown>;
  /** Look up by prefix; null if absent. Implementations should NOT compare hashes. */
  findByPrefix(prefix: string): Promise<WebhookTokenRecord | undefined>;
  /** Best-effort update of last_triggered_at; never throws. */
  touch(id: string, at?: string): Promise<void>;
}

export interface IssuedWebhookToken {
  id: string;
  plaintext: string;
  prefix: string;
  hash: string;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class WebhookTokenService {
  /** Mint a fresh token. The caller persists the row; the plaintext is shown
   * ONCE in the API response and is never recoverable from storage. */
  static issue(id: string): IssuedWebhookToken {
    const prefix = randomBytes(6).toString("hex"); // 12 chars
    const secret = randomBytes(24).toString("hex"); // 48 chars
    const plaintext = `wht_${prefix}_${secret}`;
    return { id, plaintext, prefix, hash: sha256Hex(plaintext) };
  }

  /** Parse and constant-time verify against the store. Returns the record. */
  static async verify(
    rawToken: string,
    store: Pick<WebhookTokenStore, "findByPrefix">
  ): Promise<WebhookTokenRecord> {
    const parts = rawToken.split("_");
    if (parts.length !== 3 || parts[0] !== "wht" || !parts[1] || !parts[2]) {
      throw new InvalidWebhookTokenError("Malformed webhook token");
    }
    const prefix = parts[1];
    const record = await store.findByPrefix(prefix);
    if (!record) throw new InvalidWebhookTokenError("Unknown webhook token");
    if (record.revokedAt) {
      throw new InvalidWebhookTokenError("Webhook token has been revoked");
    }
    if (!record.enabled) {
      throw new InvalidWebhookTokenError("Webhook token is disabled");
    }
    const candidate = Buffer.from(sha256Hex(rawToken), "hex");
    const expected = Buffer.from(record.hash, "hex");
    if (
      candidate.length !== expected.length ||
      !timingSafeEqual(candidate, expected)
    ) {
      throw new InvalidWebhookTokenError("Webhook token signature mismatch");
    }
    return record;
  }
}
