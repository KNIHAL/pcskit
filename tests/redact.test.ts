import { describe, expect, it } from "vitest";
import { isSensitivePath, redactDeep, redactText } from "../src/core";

// Fake secrets are assembled at runtime so secret scanners do not flag this repo.
const fake = {
  aws: "AKIA" + "ABCDEFGHIJKLMNOP",
  gh: "ghp_" + "x9Y8".repeat(9),
  sk: "sk-ant-" + "abcDEF0123456789".repeat(2),
  jwt: ["eyJhbGciOi" + "JIUzI1", "eyJzdWIiOi" + "IxMjM0", "SflKxwRJSM" + "eKKF2Q"].join("."),
  key: ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA", "-----END RSA PRIVATE KEY-----"].join("\n"),
};

describe("redactText", () => {
  it.each(Object.entries(fake))("redacts %s", (_name, secret) => {
    const r = redactText(`before ${secret} after`);
    expect(r.text).not.toContain(secret);
    expect(r.text).toContain("[REDACTED");
    expect(r.count).toBeGreaterThan(0);
  });

  it("redacts credential assignments but keeps the key name", () => {
    const r = redactText('DB_PASSWORD="hunter2hunter2" and api_key: abcdef123456');
    expect(r.text).toContain("DB_PASSWORD=[REDACTED:credential]");
    expect(r.text).toContain("api_key: [REDACTED:credential]");
    expect(r.text).not.toContain("hunter2");
  });

  it("redacts bearer tokens", () => {
    expect(redactText("Authorization: Bearer abcdefghijklmnop12345").text).not.toContain("abcdefghijklmnop12345");
  });

  it("leaves ordinary text alone", () => {
    const text = "fix tokenizer bug in src/parser.ts; count = 5";
    expect(redactText(text)).toEqual({ text, count: 0 });
  });
});

describe("redactText: formats found by QA", () => {
  const more = {
    stripe: "sk_" + "live_" + "A1b2C3d4E5f6G7h8I9j0",
    slack: "xox" + "b-123456789012-abcdefghij",
    google: "AI" + "za" + "SyA1234567890abcdefghijklmnopqrstuv",
    npm: "npm_" + "abcdefghijklmnopqrstuvwxyz0123456789",
  };

  it.each(Object.entries(more))("redacts %s tokens", (_n, secret) => {
    const r = redactText(`x ${secret} y`);
    expect(r.text).not.toContain(secret);
    expect(r.count).toBeGreaterThan(0);
  });

  it("redacts JSON-quoted secrets and keeps the key", () => {
    const r = redactText('{"password": "hunter2secret", "apiKey":"abcdef123456789", "name": "pcs"}');
    expect(r.text).not.toContain("hunter2secret");
    expect(r.text).not.toContain("abcdef123456789");
    expect(r.text).toContain('"password": [REDACTED:credential]');
    expect(r.text).toContain('"name": "pcs"');
    expect(r.count).toBe(2);
  });

  it("redacts quoted values that contain spaces", () => {
    const r = redactText('password="my long phrase" next');
    expect(r.text).not.toContain("long phrase");
    expect(r.text).toContain("next");
  });

  it("redacts the password inside a URL but keeps scheme, user and host", () => {
    const r = redactText("DATABASE_URL=postgres://admin:s3cretPass@db.example.com:5432/app");
    expect(r.text).not.toContain("s3cretPass");
    expect(r.text).toContain("postgres://admin:[REDACTED:url-credential]@db.example.com:5432/app");
  });

  it("redacts Authorization: Basic headers", () => {
    const r = redactText("Authorization: Basic dXNlcjpwYXNzd29yZA==");
    expect(r.text).not.toContain("dXNlcjpwYXNzd29yZA");
  });

  it("redacts a secret passed as the next command-line argument", () => {
    const r = redactText("deploy --token abc123456789 --verbose --api-key=zzzzzzzzzz");
    expect(r.text).not.toContain("abc123456789");
    expect(r.text).not.toContain("zzzzzzzzzz");
    expect(r.text).toContain("--verbose");
  });

  it.each([
    "token: true",
    "the password field is required",
    "npm run --tokens 100",
    "see https://example.com/docs and ssh://git@github.com/org/repo",
    "mail me at dev@example.com",
    'password: ""',
  ])("leaves harmless text alone: %s", (text) => {
    expect(redactText(text)).toEqual({ text, count: 0 });
  });
});

describe("redactDeep", () => {
  it("walks objects and arrays without mutating the input", () => {
    const input = { a: [`x ${fake.aws}`], n: 3, ok: true };
    const { value, count } = redactDeep(input);
    expect(JSON.stringify(value)).not.toContain(fake.aws);
    expect(count).toBe(1);
    expect(input.a[0]).toContain(fake.aws);
    expect((value as typeof input).n).toBe(3);
  });
});

describe("isSensitivePath", () => {
  it.each([".env", "app/.env.local", "certs/server.pem", "deploy.key", "home/.ssh/id_ed25519", ".npmrc", "infra/prod.tfvars", "terraform.tfstate"])(
    "flags %s",
    (p) => expect(isSensitivePath(p)).toBe(true),
  );

  it.each([".env.example", "src/env.ts", "id_rsa.pub", "README.md", "src/keys.ts", ""])(
    "does not flag %s",
    (p) => expect(isSensitivePath(p)).toBe(false),
  );
});
