/**
 * Account orchestration: local-password login, SSO find-or-create, and
 * self-service signup — all gated by the configurable signup mode — plus
 * session issuance. Framework-agnostic and structurally typed so the API can
 * pass the concrete @ragdoll/db repositories without auth depending on db.
 */
import { randomUUID } from "node:crypto";
import { InvalidCredentialsError } from "./index.ts";
import type { Principal } from "./index.ts";
import type { SessionTokenService } from "./index.ts";
import { PasswordService } from "./password.ts";
import type { SsoIdentity } from "./oidc.ts";

export interface LocalUser {
  id: string;
  email: string;
  displayName?: string | null;
  passwordHash?: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserStore {
  get(id: string): Promise<LocalUser | undefined>;
  findByEmail(email: string): Promise<LocalUser | undefined>;
  create(row: LocalUser): Promise<LocalUser>;
  update(id: string, patch: Partial<LocalUser>): Promise<LocalUser>;
}

export interface IdentityRecord {
  id: string;
  userId: string;
  provider: string;
  subject: string;
  email?: string | null;
  createdAt: string;
}

export interface IdentityStore {
  findBySubject(
    provider: string,
    subject: string
  ): Promise<IdentityRecord | undefined>;
  create(row: IdentityRecord): Promise<IdentityRecord>;
}

export interface GrantStore {
  addGrant(row: {
    id: string;
    userId: string;
    role: string;
    scope: string;
    createdAt: string;
  }): Promise<unknown>;
}

export type SignupMode =
  | "admin_only"
  | "open_default_role"
  | "open_no_access";

export interface SettingsStore {
  get(): Promise<{ signupMode: SignupMode; defaultRole?: string | null }>;
}

export class SignupDisabledError extends Error {
  constructor() {
    super("Self-service signup is disabled");
    this.name = "SignupDisabledError";
  }
}

export class AccountDisabledError extends Error {
  constructor() {
    super("This account is disabled");
    this.name = "AccountDisabledError";
  }
}

export class EmailInUseError extends Error {
  constructor() {
    super("An account with that email already exists");
    this.name = "EmailInUseError";
  }
}

export interface AuthOutcome {
  token: string;
  principal: Principal;
  user: LocalUser;
}

export interface AccountServiceDeps {
  users: UserStore;
  identities: IdentityStore;
  grants: GrantStore;
  settings: SettingsStore;
  sessions: SessionTokenService;
  passwords?: PasswordService;
  /** Session lifetime; defaults to 12h. */
  sessionTtlSeconds?: number;
}

export class AccountService {
  private d: AccountServiceDeps;
  private passwords: PasswordService;
  private ttl: number;

  constructor(deps: AccountServiceDeps) {
    this.d = deps;
    this.passwords = deps.passwords ?? new PasswordService();
    this.ttl = deps.sessionTtlSeconds ?? 12 * 60 * 60;
  }

  private issue(user: LocalUser): AuthOutcome {
    // The session token only *identifies* the user; grants are resolved live
    // by the Authorizer so role/grant changes (and revocations) take effect
    // without re-login.
    const principal: Principal = { id: user.id, type: "user", roles: [] };
    const token = this.d.sessions.sign(principal, this.ttl);
    return { token, principal, user };
  }

  private assertActive(user: LocalUser): void {
    if (user.status !== "active") throw new AccountDisabledError();
  }

  /** Local email + password. */
  async loginLocal(email: string, password: string): Promise<AuthOutcome> {
    const user = await this.d.users.findByEmail(email.trim().toLowerCase());
    // Verify even when the user is missing to keep timing uniform.
    const ok = await this.passwords.verify(
      password,
      user?.passwordHash ?? null
    );
    if (!user || !ok) throw new InvalidCredentialsError();
    this.assertActive(user);
    return this.issue(user);
  }

  /**
   * SSO callback: find the identity, else link to an existing same-email
   * account, else auto-provision. New users get the configured default role
   * only when signup mode is `open_default_role`; otherwise they are created
   * with NO access until an admin grants it (covers admin_only & no_access).
   */
  async loginSso(
    provider: string,
    identity: SsoIdentity
  ): Promise<AuthOutcome> {
    const existing = await this.d.identities.findBySubject(
      provider,
      identity.subject
    );
    if (existing) {
      const user = await this.d.users.get(existing.userId);
      if (!user) throw new InvalidCredentialsError();
      this.assertActive(user);
      return this.issue(user);
    }

    const now = new Date().toISOString();
    let user: LocalUser | undefined;
    if (identity.email) {
      user = await this.d.users.findByEmail(identity.email.toLowerCase());
    }
    if (user) {
      this.assertActive(user);
    } else {
      user = await this.d.users.create({
        id: randomUUID(),
        email: (identity.email ?? `${provider}:${identity.subject}`).toLowerCase(),
        displayName: identity.name ?? null,
        passwordHash: null,
        status: "active",
        createdAt: now,
        updatedAt: now
      });
      const settings = await this.d.settings.get();
      if (
        settings.signupMode === "open_default_role" &&
        settings.defaultRole
      ) {
        await this.d.grants.addGrant({
          id: randomUUID(),
          userId: user.id,
          role: settings.defaultRole,
          scope: "*",
          createdAt: now
        });
      }
    }
    await this.d.identities.create({
      id: randomUUID(),
      userId: user.id,
      provider,
      subject: identity.subject,
      email: identity.email ?? null,
      createdAt: now
    });
    return this.issue(user);
  }

  /** Self-service local signup, honouring the signup-mode flag. */
  async signupLocal(input: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<AuthOutcome> {
    const settings = await this.d.settings.get();
    if (settings.signupMode === "admin_only") {
      throw new SignupDisabledError();
    }
    const email = input.email.trim().toLowerCase();
    if (await this.d.users.findByEmail(email)) throw new EmailInUseError();
    const now = new Date().toISOString();
    const user = await this.d.users.create({
      id: randomUUID(),
      email,
      displayName: input.displayName ?? null,
      passwordHash: await this.passwords.hash(input.password),
      status: "active",
      createdAt: now,
      updatedAt: now
    });
    if (settings.signupMode === "open_default_role" && settings.defaultRole) {
      await this.d.grants.addGrant({
        id: randomUUID(),
        userId: user.id,
        role: settings.defaultRole,
        scope: "*",
        createdAt: now
      });
    }
    return this.issue(user);
  }
}
