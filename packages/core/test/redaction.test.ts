import test from "node:test";
import assert from "node:assert/strict";
import { redactValue, looksSensitive, isSensitiveKey } from "../src/index.ts";

// A realistic, multi-hundred-char markdown/prose blob as produced by crawling a
// web page (e.g. a CNN article). It contains many 32+ char alphanumeric runs
// (in URLs, slugs, hashes) but is plainly natural language and MUST NOT be
// redacted, otherwise execution traces / debug console lose all observability.
const CRAWLED_MARKDOWN = `# Breaking News: Markets Rally on Strong Earnings

Published 2026-05-18 by the CNN Business desk. Read more at
https://www.cnn.com/2026/05/18/business/markets-rally-strong-earnings-report/index.html

Stocks surged on Monday after a string of better-than-expected corporate
earnings reports reassured investors who had been worried about a slowdown.
The benchmark index climbed roughly 1.8 percent in afternoon trading, with
technology and consumer-discretionary names leading the advance.

"The breadth of this rally is what makes it encouraging," said an analyst at a
large asset manager. "We are seeing participation across nearly every sector,
not just the megacap technology companies that have dominated returns."

Article fingerprint: 9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a
Related coverage: see our live blog and the longer analysis piece linked above.

Investors will turn next to inflation data due later this week, which could
shape expectations for the central bank's next policy meeting in June.`;

test("realistic crawled markdown/prose with long alnum runs is NOT redacted", () => {
  assert.equal(looksSensitive(CRAWLED_MARKDOWN), false);
  assert.equal(redactValue(CRAWLED_MARKDOWN), CRAWLED_MARKDOWN);

  // Long single-sentence prose with a hash-like run in it.
  const sentence =
    "The deployment artifact 9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a was promoted to production after passing all checks.";
  assert.equal(looksSensitive(sentence), false);
  assert.equal(redactValue(sentence), sentence);

  // Model output containing a long base64-looking word inside a sentence.
  const modelOut =
    "Here is the encoded payload aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgYmFzZTY0IHN0cmluZw== which decodes to a greeting.";
  assert.equal(looksSensitive(modelOut), false);

  // Plain medium strings stay untouched.
  assert.equal(redactValue("hello e2e"), "hello e2e");
  assert.equal(redactValue("what is the capital of France?"), "what is the capital of France?");
});

test("genuine secrets and credential shapes ARE redacted", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const samples: Array<[string, string]> = [
    ["sk- prefixed key", "sk-supersecret-plaintext"],
    ["sk- short", "sk-rotated"],
    ["JWT", jwt],
    ["github token", "ghp_16C7e42F292c6912E7710c838347Ae178B4a"],
    ["slack bot token", "xoxb-2222222222-3333333333-abcdEFGHijklMNOPqrstUVwx"],
    ["postgres url", "postgres://u:p@db.internal:5432/app"],
    ["generic conn string", "mysql://admin:s3cr3tP@ss@10.0.0.5/orders"],
    ["50-char no-space base64 token", "QWxhZGRpbjpvcGVuc2VzYW1lUGFkZGluZ0Jhc2U2NFRva2VuMTIzNDU2"],
    ["Bearer token", "Bearer abcDEF1234567890ghijKLMNopqrstUVWXyz567890"]
  ];
  for (const [label, value] of samples) {
    assert.equal(looksSensitive(value), true, `${label} should look sensitive`);
    assert.equal(redactValue(value), "REDACTED", `${label} should be redacted`);
  }
});

test("values under sensitive KEYS are redacted even when value is plain prose", () => {
  const input = {
    apiKey: "this is just a short readable phrase",
    password: "correct horse battery staple",
    authorization: "let me in please",
    api_key: "tenant prod key human readable",
    connection_string: "db over there",
    private_key: "no entropy here at all",
    // Non-sensitive key with prose value stays intact.
    description: "A long human written description with many words and no secrets whatsoever included here.",
    notes: "9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c spread across a sentence is fine"
  };
  const out = redactValue(input) as Record<string, unknown>;
  assert.equal(out.apiKey, "REDACTED");
  assert.equal(out.password, "REDACTED");
  assert.equal(out.authorization, "REDACTED");
  assert.equal(out.api_key, "REDACTED");
  assert.equal(out.connection_string, "REDACTED");
  assert.equal(out.private_key, "REDACTED");
  assert.equal(out.description, input.description);
  assert.equal(out.notes, input.notes);

  // isSensitiveKey behavior is unchanged.
  assert.equal(isSensitiveKey("apiKey"), true);
  assert.equal(isSensitiveKey("api_key"), true);
  assert.equal(isSensitiveKey("Authorization"), true);
  assert.equal(isSensitiveKey("password"), true);
  assert.equal(isSensitiveKey("secret"), true);
  assert.equal(isSensitiveKey("token"), true);
  assert.equal(isSensitiveKey("connection_string"), true);
  assert.equal(isSensitiveKey("private_key"), true);
  assert.equal(isSensitiveKey("question"), false);
  assert.equal(isSensitiveKey("markdown"), false);
});

test("redactValue recursion/structure is unchanged", () => {
  assert.equal(redactValue(null), null);
  assert.equal(redactValue(undefined), undefined);
  assert.equal(redactValue(42), 42);
  assert.equal(redactValue(true), true);

  const nested = {
    level1: {
      keep: "ordinary prose value that is perfectly safe",
      token: "QWxhZGRpbjpvcGVuc2VzYW1lUGFkZGluZ0Jhc2U2NFRva2VuMTIzNDU2",
      list: [
        "plain text",
        { password: "human readable", deep: ["sk-deep-secret", "still fine here"] }
      ]
    }
  };
  const out = redactValue(nested) as any;
  assert.equal(out.level1.keep, "ordinary prose value that is perfectly safe");
  assert.equal(out.level1.token, "REDACTED");
  assert.equal(out.level1.list[0], "plain text");
  assert.equal(out.level1.list[1].password, "REDACTED");
  assert.equal(out.level1.list[1].deep[0], "REDACTED");
  assert.equal(out.level1.list[1].deep[1], "still fine here");
  assert.ok(Array.isArray(out.level1.list));
  assert.equal(Object.keys(out.level1).length, 3);
});
