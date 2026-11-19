import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withDb } from "./context";
import type { Db } from "./db";
import { PcsError } from "./errors";
import { canonicalJson } from "./events";
import { verifyIntegrity } from "./integrity";
import { workspaceDir } from "./workspace";

/**
 * Signed anchor: a small file holding the log's head hash and event count,
 * signed with a local ed25519 key that lives OUTSIDE the project (in the
 * workspace dir). Keep the file somewhere the log writer cannot reach (another
 * disk, a commit, a ticket). `verify --anchor` then catches what the hash chain
 * alone cannot: truncation of the newest events and a full recomputed rewrite.
 */
export const ANCHOR_VERSION = 1;

export interface Anchor {
  version: number;
  created_at: string;
  last_id: number;
  count: number;
  head: string;
  key_id: string;
  public_key: string;
  signature: string;
}

export interface AnchorCheck {
  ok: boolean;
  reason?: string;
  anchor?: Pick<Anchor, "created_at" | "last_id" | "count" | "head" | "key_id">;
  keyTrusted: boolean;
}

export function anchorKeyPath(): string {
  return join(workspaceDir(), "anchor.key");
}

function keyIdOf(publicKeyB64: string): string {
  return createHash("sha256").update(publicKeyB64).digest("hex").slice(0, 16);
}

function loadOrCreateKey(create: boolean): KeyObject | null {
  const path = anchorKeyPath();
  if (existsSync(path)) {
    try {
      return createPrivateKey(readFileSync(path, "utf8"));
    } catch {
      throw new PcsError("INVALID_INPUT", `Anchor key is unreadable: ${path}`);
    }
  }
  if (!create) return null;
  mkdirSync(dirname(path), { recursive: true });
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, pem, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
  return privateKey;
}

function publicKeyB64(key: KeyObject): string {
  return createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
}

function signedBytes(a: Omit<Anchor, "signature">): Buffer {
  return Buffer.from(canonicalJson({ ...a }), "utf8");
}

function head(db: Db): { last_id: number; count: number; head: string } {
  const last = db.prepare("SELECT id, hash FROM events ORDER BY id DESC LIMIT 1").get() as
    | { id: number; hash: string }
    | undefined;
  const c = db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
  if (!last) throw new PcsError("INVALID_INPUT", "The event log is empty; nothing to anchor.");
  return { last_id: Number(last.id), count: Number(c.n), head: last.hash };
}

/** Create a signed anchor for the current log head. Refuses to anchor a log that already fails verification. */
export async function createAnchor(cwd: string): Promise<Anchor> {
  return withDb(cwd, (db) => {
    const integrity = verifyIntegrity(db);
    if (!integrity.ok) {
      throw new PcsError("INTEGRITY_FAILURE", `Refusing to anchor a log that fails verification: ${integrity.reason ?? "unknown"}`);
    }
    const key = loadOrCreateKey(true) as KeyObject;
    const pub = publicKeyB64(key);
    const body = {
      version: ANCHOR_VERSION,
      created_at: new Date().toISOString(),
      ...head(db),
      key_id: keyIdOf(pub),
      public_key: pub,
    };
    const signature = sign(null, signedBytes(body), key).toString("base64");
    return { ...body, signature };
  });
}

export function parseAnchor(text: string): Anchor {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PcsError("INVALID_INPUT", "Anchor file is not valid JSON.");
  }
  const a = raw as Partial<Anchor>;
  const ok =
    a &&
    typeof a === "object" &&
    a.version === ANCHOR_VERSION &&
    typeof a.created_at === "string" &&
    Number.isInteger(a.last_id) &&
    Number.isInteger(a.count) &&
    typeof a.head === "string" &&
    /^[0-9a-f]{64}$/.test(a.head) &&
    typeof a.key_id === "string" &&
    typeof a.public_key === "string" &&
    typeof a.signature === "string";
  if (!ok) throw new PcsError("INVALID_INPUT", "Anchor file has an unexpected shape or version.");
  return a as Anchor;
}

export function checkAnchorAgainstDb(db: Db, a: Anchor): AnchorCheck {
  const summary = { created_at: a.created_at, last_id: a.last_id, count: a.count, head: a.head, key_id: a.key_id };
  const fail = (reason: string, keyTrusted = false): AnchorCheck => ({ ok: false, reason, anchor: summary, keyTrusted });

  let valid = false;
  try {
    const { signature, ...body } = a;
    const pub = createPublicKey({ key: Buffer.from(a.public_key, "base64"), format: "der", type: "spki" });
    valid = verify(null, signedBytes(body), pub, Buffer.from(signature, "base64"));
  } catch {
    valid = false;
  }
  if (!valid) return fail("anchor signature is invalid");

  let keyTrusted = false;
  try {
    const local = loadOrCreateKey(false);
    keyTrusted = local !== null && keyIdOf(publicKeyB64(local)) === a.key_id && publicKeyB64(local) === a.public_key;
  } catch {
    keyTrusted = false;
  }
  if (!keyTrusted) return fail("anchor was not signed by this machine's key", false);

  const row = db.prepare("SELECT hash FROM events WHERE id = ?").get(a.last_id) as { hash: string } | undefined;
  if (!row) return fail(`event #${a.last_id} is missing: the log was truncated or replaced since the anchor`, true);
  if (row.hash !== a.head) return fail(`event #${a.last_id} differs from the anchored head: the log was rewritten since the anchor`, true);
  const c = db.prepare("SELECT COUNT(*) AS n FROM events WHERE id <= ?").get(a.last_id) as { n: number };
  if (Number(c.n) !== a.count) return fail(`expected ${a.count} events up to #${a.last_id}, found ${c.n}: events were removed`, true);
  return { ok: true, anchor: summary, keyTrusted: true };
}

/** Full verification (chain, snapshots, test runs) plus the anchor check. */
export async function verifyAnchor(cwd: string, file: string): Promise<{ integrity: ReturnType<typeof verifyIntegrity>; anchor: AnchorCheck }> {
  if (!existsSync(file)) throw new PcsError("INVALID_INPUT", `Anchor file not found: ${file}`);
  const a = parseAnchor(readFileSync(file, "utf8"));
  return withDb(cwd, (db) => ({ integrity: verifyIntegrity(db), anchor: checkAnchorAgainstDb(db, a) }));
}
