/**
 * Local-password hashing. Pure `node:crypto` scrypt (memory-hard, in the Node
 * core) so it stays dependency-free and the install-free test runner can
 * exercise it directly — matching how the rest of @ragdoll/auth avoids deps.
 *
 * Stored format (self-describing so parameters can evolve):
 *   scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>
 * Verification is constant-time via `timingSafeEqual`.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keyLen: number;
}

// OWASP-aligned defaults (N=2^16). `maxmem` must be raised for these.
const DEFAULTS: ScryptParams = { N: 1 << 16, r: 8, p: 1, keyLen: 32 };

function scryptAsync(
  password: string,
  salt: Buffer,
  params: ScryptParams
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      params.keyLen,
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 },
      (err, derived) => (err ? reject(err) : resolve(derived as Buffer))
    );
  });
}

export class PasswordService {
  private params: ScryptParams;

  constructor(params: Partial<ScryptParams> = {}) {
    this.params = { ...DEFAULTS, ...params };
  }

  async hash(password: string): Promise<string> {
    if (!password || password.length < 8) {
      throw new WeakPasswordError();
    }
    const salt = randomBytes(16);
    const derived = await scryptAsync(password, salt, this.params);
    const { N, r, p } = this.params;
    return [
      "scrypt",
      N,
      r,
      p,
      salt.toString("base64"),
      derived.toString("base64")
    ].join("$");
  }

  /** Constant-time verify. Never throws on a bad password — returns false. */
  async verify(password: string, stored: string | null | undefined): Promise<boolean> {
    if (!stored) return false;
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
      return false;
    }
    let salt: Buffer;
    let expected: Buffer;
    try {
      salt = Buffer.from(parts[4], "base64");
      expected = Buffer.from(parts[5], "base64");
    } catch {
      return false;
    }
    let derived: Buffer;
    try {
      derived = await scryptAsync(password, salt, {
        N,
        r,
        p,
        keyLen: expected.length
      });
    } catch {
      return false;
    }
    return (
      derived.length === expected.length && timingSafeEqual(derived, expected)
    );
  }
}

export class WeakPasswordError extends Error {
  constructor() {
    super("Password must be at least 8 characters");
    this.name = "WeakPasswordError";
  }
}
