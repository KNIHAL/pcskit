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
