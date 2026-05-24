import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import type { SecretRef, SecretProviderKind } from "../../core/src/index.ts";

export interface SecretRecord {
  id: string;
  provider: SecretProviderKind;
  ref: SecretRef;
  ciphertext: string;
  version: string;
  keyId: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface SecretProvider {
  kind: SecretProviderKind;
  put(ref: SecretRef, value: string, metadata?: Record<string, unknown>): Promise<SecretRecord>;
  get(ref: SecretRef, tenantBoundary?: string): Promise<string>;
  delete(ref: SecretRef, tenantBoundary?: string): Promise<void>;
  list(scope: Partial<SecretRef>): Promise<Array<Omit<SecretRecord, "ciphertext">>>;
}

export interface SecretRepository {
  upsert(record: SecretRecord): Promise<SecretRecord>;
  find(ref: SecretRef): Promise<SecretRecord | undefined>;
  delete(ref: SecretRef): Promise<void>;
  list(scope: Partial<SecretRef>): Promise<SecretRecord[]>;
}

export interface KeyEncryptionKeyProvider {
  currentKey(): Promise<{ keyId: string; key: Buffer }>;
  keyById(keyId: string): Promise<Buffer>;
}

export class StaticKeyProvider implements KeyEncryptionKeyProvider {
  private key: Buffer;

  constructor(secret: string) {
    this.key = createHash("sha256").update(secret).digest();
  }

  async currentKey(): Promise<{ keyId: string; key: Buffer }> {
    return { keyId: "static-env-key", key: this.key };
  }

  async keyById(): Promise<Buffer> {
    return this.key;
  }
}

export class InMemorySecretRepository implements SecretRepository {
  private records = new Map<string, SecretRecord>();

  async upsert(record: SecretRecord): Promise<SecretRecord> {
    this.records.set(secretRefKey(record.ref), record);
    return record;
  }

  async find(ref: SecretRef): Promise<SecretRecord | undefined> {
    return this.records.get(secretRefKey(ref));
  }

  async delete(ref: SecretRef): Promise<void> {
    this.records.delete(secretRefKey(ref));
  }

  async list(scope: Partial<SecretRef>): Promise<SecretRecord[]> {
    return [...this.records.values()].filter((record) => matchesPartialRef(record.ref, scope));
  }
}

export class DatabaseEncryptedSecretProvider implements SecretProvider {
  kind: SecretProviderKind = "database_encrypted";
  private repository: SecretRepository;
  private keys: KeyEncryptionKeyProvider;

  constructor(repository: SecretRepository, keys: KeyEncryptionKeyProvider) {
    this.repository = repository;
    this.keys = keys;
  }

  async put(ref: SecretRef, value: string, metadata?: Record<string, unknown>): Promise<SecretRecord> {
    const { key, keyId } = await this.keys.currentKey();
    const encrypted = encrypt(value, key);
    const now = new Date().toISOString();
    const existing = await this.repository.find(ref);
    const record: SecretRecord = {
      id: existing?.id ?? createHash("sha256").update(secretRefKey(ref)).digest("hex"),
      provider: this.kind,
      ref: { ...ref, provider: this.kind },
      ciphertext: encrypted,
      version: String(Number(existing?.version ?? 0) + 1),
      keyId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      metadata
    };
    return this.repository.upsert(record);
  }

  async get(ref: SecretRef, tenantBoundary?: string): Promise<string> {
    enforceTenantBoundary(ref, tenantBoundary);
    // A tenant-scoped ref intentionally omits `tenantId` so the same pipeline
    // spec is portable across tenants — each run resolves its own secret.
    // Inject the runtime's tenant boundary as the effective tenantId before
    // we hit the repo; without this every tenant ref 404s with the spec
    // shape the seeds and `code_indexer` use.
    const lookupRef = resolveTenantRef(ref, tenantBoundary);
    const record = await this.repository.find(lookupRef);
    if (!record) throw new SecretNotFoundError(lookupRef);
    const key = await this.keys.keyById(record.keyId);
    return decrypt(record.ciphertext, key);
  }

  async delete(ref: SecretRef, tenantBoundary?: string): Promise<void> {
    enforceTenantBoundary(ref, tenantBoundary);
    await this.repository.delete(resolveTenantRef(ref, tenantBoundary));
  }

  async list(scope: Partial<SecretRef>): Promise<Array<Omit<SecretRecord, "ciphertext">>> {
    return (await this.repository.list(scope)).map(({ ciphertext, ...record }) => record);
  }
}

export class SecretNotFoundError extends Error {
  constructor(ref: SecretRef) {
    super(`Secret not found for ${secretRefKey(ref)}`);
    this.name = "SecretNotFoundError";
  }
}

export class SecretAccessDeniedError extends Error {
  constructor() {
    super("Secret access denied by tenant boundary");
    this.name = "SecretAccessDeniedError";
  }
}

export function secretRefKey(ref: SecretRef): string {
  return [ref.scope, ref.tenantId ?? "", ref.environment ?? "", ref.key, ref.version ?? ""].join(":");
}

export function redactedSecretList(records: Array<Omit<SecretRecord, "ciphertext">>): Array<Record<string, unknown>> {
  return records.map((record) => ({
    id: record.id,
    provider: record.provider,
    ref: record.ref,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    metadata: record.metadata,
    value: "REDACTED"
  }));
}

function enforceTenantBoundary(ref: SecretRef, tenantBoundary?: string): void {
  if (tenantBoundary && ref.tenantId && ref.tenantId !== tenantBoundary) {
    throw new SecretAccessDeniedError();
  }
}

/**
 * For a tenant-scoped ref with no `tenantId`, fill it in from the runtime
 * boundary. Refs with an explicit `tenantId` are left alone — the boundary
 * check above already guarantees the explicit value matches the runtime
 * tenant. No-op for non-tenant scopes.
 */
function resolveTenantRef(ref: SecretRef, tenantBoundary?: string): SecretRef {
  if (ref.scope !== "tenant") return ref;
  if (ref.tenantId) return ref;
  if (!tenantBoundary) return ref;
  return { ...ref, tenantId: tenantBoundary };
}

function matchesPartialRef(ref: SecretRef, partial: Partial<SecretRef>): boolean {
  return Object.entries(partial).every(([key, value]) => value === undefined || ref[key as keyof SecretRef] === value);
}

function encrypt(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

function decrypt(payload: string, key: Buffer): string {
  const buffer = Buffer.from(payload, "base64");
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const ciphertext = buffer.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
