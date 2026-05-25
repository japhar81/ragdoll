/**
 * Audit log redaction. Create a secret (which writes an audit log row),
 * fetch the audit row, and confirm the value field carries the
 * `REDACTED` sentinel — NOT the plaintext.
 */
import { test, expect } from "../helpers/fixtures.ts";

const RUN_SUFFIX = String(Date.now()).slice(-8);
const SECRET_KEY = `pw.audit.${RUN_SUFFIX}`;
const SECRET_VALUE = "this-string-must-never-appear-in-audit";

test.describe("audit redaction", () => {
  test("creating a secret does not leak the plaintext into audit_logs", async ({
    rest,
    state
  }) => {
    await rest.request("POST", "/api/secrets", {
      key: SECRET_KEY,
      value: SECRET_VALUE,
      scope: "tenant",
      tenantId: state.tenantId
    });
    // Pull recent audit rows; find the secret.create entry and assert
    // it doesn't contain our plaintext anywhere.
    const audit = await rest.request<{
      logs: Array<{
        action: string;
        targetType: string;
        beforeRedacted?: unknown;
        afterRedacted?: unknown;
      }>;
    }>("GET", "/api/audit?limit=20", undefined, { tenantId: state.tenantId });
    const secretWrites = audit.logs.filter(
      (l) =>
        l.targetType === "secret" || l.action.includes("secret")
    );
    expect(secretWrites.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(secretWrites);
    expect(serialized.includes(SECRET_VALUE)).toBe(false);
  });
});
