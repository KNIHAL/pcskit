/**
 * Secret hygiene. PCS stores development context that gets handed to other AI
 * providers, so anything that looks like a credential is redacted before it is
 * persisted, and well-known secret files are flagged so their content is never read.
 */

const RULES: ReadonlyArray<readonly [kind: string, pattern: RegExp]> = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g],
  ["api-key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi],
  ["payment-key", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/g],
];

/** `Authorization: Basic ...` (the Bearer form is covered by a rule above). */
const AUTH_HEADER = /(\bAuthorization\s*[:=]\s*)(?:Basic|Digest)\s+\S+/gi;

/** user:password@ inside a URL (postgres://, https://, ...). The scheme and user stay. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;

const KEY_NAME =
  "[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*";

/**
 * key = value / key: value where the key name looks credential-like. Handles a
 * quoted key (JSON: "password": "..."), a quoted value with spaces, and an
 * unquoted value of at least 6 characters.
 */
const ASSIGNMENT = new RegExp(
  `\\b(${KEY_NAME})(["']?)(\\s*[:=]\\s*)(?:(["'])[^"'\\r\\n]{4,}\\4|[^\\s"',;}]{6,})`,
  "gi",
);

/** A secret passed as the next argument: `--token abc123`, `--api-key abc123`. */
const CLI_FLAG = /(--[a-z0-9-]*(?:password|passwd|secret|token|api-?key)[a-z0-9-]*)(\s+)(?!-)[^\s]{6,}/gi;

export interface RedactionResult {
  text: string;
  count: number;
}

export function redactText(input: string): RedactionResult {
  let count = 0;
  let text = input;
  for (const [kind, pattern] of RULES) {
    text = text.replace(pattern, () => {
      count++;
      return `[REDACTED:${kind}]`;
    });
  }
  text = text.replace(AUTH_HEADER, (_m, head: string) => {
    count++;
    return `${head}[REDACTED:auth-header]`;
  });
  text = text.replace(URL_CREDENTIALS, (_m, head: string) => {
    count++;
    return `${head}[REDACTED:url-credential]@`;
  });
  text = text.replace(ASSIGNMENT, (_m, key: string, keyQuote: string, sep: string) => {
    count++;
    return `${key}${keyQuote}${sep}[REDACTED:credential]`;
  });
  text = text.replace(CLI_FLAG, (_m, flag: string, space: string) => {
    count++;
    return `${flag}${space}[REDACTED:credential]`;
  });
  return { text, count };
}

/** Redact every string inside a JSON-like value. Returns a new value. */
export function redactDeep(value: unknown): { value: unknown; count: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactText(v);
      count += r.count;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return { value: walk(value), count };
}

const SENSITIVE_NAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  "credentials",
  "credentials.json",
  "secrets.json",
  "secrets.yml",
  "secrets.yaml",
  "terraform.tfstate",
]);

/** True for files that commonly hold secrets. Their content must never be read into a handoff. */
export function isSensitivePath(path: string): boolean {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (!name) return false;
  if (name === ".env") return true;
  if (name.startsWith(".env.") && !/\.(example|sample|template|dist)$/.test(name)) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore|kdbx|tfvars)$/.test(name)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(name)) return true;
  return SENSITIVE_NAMES.has(name);
}
