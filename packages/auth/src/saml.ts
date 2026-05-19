/**
 * SAML 2.0 Web-SSO provider.
 *
 * SAML requires XML canonicalisation + XML-DSig verification, which is not
 * worth hand-rolling; we lazily import the maintained `@node-saml/node-saml`
 * (same lazy pattern as bullmq/pg/casbin) so the install-free test runner is
 * unaffected and the Docker image — which runs `npm install` — gets real SAML.
 */
import type { SsoIdentity } from "./oidc.ts";

export interface SamlConfig {
  /** IdP SSO redirect endpoint. */
  entryPoint: string;
  /** SP entity id (issuer). */
  issuer: string;
  /** ACS URL the IdP posts the assertion back to. */
  callbackUrl: string;
  /** IdP signing certificate (PEM body, no headers). */
  idpCert: string;
  /** Optional attribute names to source email / display name from. */
  emailAttribute?: string;
  nameAttribute?: string;
}

interface SamlInstance {
  getAuthorizeUrlAsync(
    relayState: string,
    host: string | undefined,
    options: Record<string, unknown>
  ): Promise<string>;
  validatePostResponseAsync(body: {
    SAMLResponse: string;
  }): Promise<{ profile: Record<string, unknown> | null }>;
}
interface SamlModule {
  SAML: new (options: Record<string, unknown>) => SamlInstance;
}

export class SamlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SamlError";
  }
}

export class SamlProvider {
  private config: SamlConfig;
  private instance?: SamlInstance;

  constructor(config: SamlConfig) {
    this.config = config;
  }

  private async saml(): Promise<SamlInstance> {
    if (this.instance) return this.instance;
    const mod = (await import(
      "@node-saml/node-saml" as string
    )) as unknown as SamlModule;
    this.instance = new mod.SAML({
      entryPoint: this.config.entryPoint,
      issuer: this.config.issuer,
      callbackUrl: this.config.callbackUrl,
      idpCert: this.config.idpCert,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: true,
      // The SP-initiated redirect is unsigned by default; assertions must be
      // signed (enforced above), which is the security-relevant property.
      disableRequestedAuthnContext: true
    });
    return this.instance;
  }

  async loginRedirectUrl(relayState: string): Promise<string> {
    const saml = await this.saml();
    return saml.getAuthorizeUrlAsync(relayState, undefined, {});
  }

  async validatePostResponse(body: {
    SAMLResponse: string;
  }): Promise<SsoIdentity> {
    const saml = await this.saml();
    const { profile } = await saml.validatePostResponseAsync(body);
    if (!profile) throw new SamlError("SAML response had no profile");
    const subject =
      (profile.nameID as string | undefined) ??
      (profile["urn:oid:0.9.2342.19200300.100.1.1"] as string | undefined);
    if (!subject) throw new SamlError("SAML assertion has no NameID");
    const emailAttr = this.config.emailAttribute ?? "email";
    const nameAttr = this.config.nameAttribute ?? "displayName";
    return {
      subject,
      email:
        (profile[emailAttr] as string | undefined) ??
        (profile.email as string | undefined),
      name:
        (profile[nameAttr] as string | undefined) ??
        (profile.displayName as string | undefined)
    };
  }
}
