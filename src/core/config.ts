import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { pcsDir } from "./db";
import { PcsError } from "./errors";
import { registerPolicyRules } from "./redact";
import { workspaceDir } from "./workspace";

/**
 * Policy file. Two optional files, both JSON: the global one (`<workspace dir>/config.json`, e.g. ~/.pcs) and the
 * project one (`.pcs/config.json`). Every setting can only TIGHTEN PCS's defaults (more redaction, more sensitive
 * paths, a test-command allowlist, lower caps); nothing here can switch a protection off. When both files exist
 * the effective policy is the union of redaction/sensitive rules, and a command must satisfy BOTH allowlists.
 * The project file lives where an agent could edit it; put anything that must hold in the global file.
 */
export const CONFIG_FILE = "config.json";
export const DEFAULT_MAX_NOTE_CHARS = 2000;
export const DEFAULT_MAX_TEST_OUTPUT_CHARS = 8192;

const MAX_RULES = 50;
const MAX_PATTERN = 500;

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/, "name: letters, digits, - and _ (max 32)");

const schema = z
  .object({
    redaction: z
      .object({
        patterns: z
          .array(
            z
              .object({
                name,
                pattern: z.string().min(1).max(MAX_PATTERN),
                flags: z.string().regex(/^[imsu]*$/, "flags: any of i m s u").optional(),
              })
              .strict(),
          )
          .max(MAX_RULES),
      })
      .strict()
      .optional(),
    sensitivePaths: z.array(z.string().min(1).max(200)).max(MAX_RULES).optional(),
    test: z
      .object({ allow: z.array(z.string().min(1).max(200)).max(MAX_RULES) })
      .strict()
      .optional(),
    caps: z
      .object({
        maxNoteChars: z.number().int().min(100).max(DEFAULT_MAX_NOTE_CHARS).optional(),
        maxTestOutputChars: z.number().int().min(500).max(DEFAULT_MAX_TEST_OUTPUT_CHARS).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PcsConfig = z.infer<typeof schema>;

export interface Policy {
  /** One allowlist per config file; a command must satisfy ALL of them (none = no restriction). Entries are command prefixes like "npm test". */
  testAllow: string[][][];
  stamp: string;
  maxNoteChars: number;
  maxTestOutputChars: number;
  sources: string[];
}

export function projectConfigPath(root: string): string {
  return join(pcsDir(root), CONFIG_FILE);
}
export function globalConfigPath(): string {
  return join(workspaceDir(), CONFIG_FILE);
}

const MAX_CONFIG_BYTES = 64 * 1024;

function readConfig(file: string): PcsConfig | null {
  if (!existsSync(file)) return null;
  if (statSync(file).size > MAX_CONFIG_BYTES) throw new PcsError("INVALID_INPUT", `${file}: config file is larger than ${MAX_CONFIG_BYTES} bytes.`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new PcsError("INVALID_INPUT", `${file}: not valid JSON.`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PcsError("INVALID_INPUT", `${file}: ${issue?.path.join(".") || "config"}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

function compile(file: string, p: { name: string; pattern: string; flags?: string | undefined }): [string, RegExp] {
  let re: RegExp;
  try {
    re = new RegExp(p.pattern, `g${p.flags ?? ""}`);
  } catch {
    throw new PcsError("INVALID_INPUT", `${file}: redaction pattern "${p.name}" is not a valid regular expression.`);
  }
  if (new RegExp(`^(?:${p.pattern})$`, p.flags ?? "").test("")) {
    throw new PcsError("INVALID_INPUT", `${file}: redaction pattern "${p.name}" matches empty text.`);
  }
  return [p.name, re];
}

/** `**` any depth, `*` within a path segment, `?` one character. A pattern without `/` matches the file name only. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, "/");
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === "*") {
      if (g[i + 1] === "*") {
        out += ".*";
        i++;
        if (g[i + 1] === "/") i++;
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`(?:^|/)${out}$`, "i");
}

const cache = new Map<string, Policy>();

/** Load and apply the policy for a project root. Called whenever a project is opened. Cheap: re-reads only when a file changed. */
export function loadPolicy(root: string): Policy {
  const files = [globalConfigPath(), projectConfigPath(root)];
  const stamp = files.map((f) => (existsSync(f) ? `${f}:${statSync(f).mtimeMs}:${statSync(f).size}` : `${f}:-`)).join("|");
  const hit = cache.get(root);
  if (hit && hit.stamp === stamp) return hit;

  const rules: Array<[string, RegExp]> = [];
  const sensitive: RegExp[] = [];
  const allow: string[][][] = [];
  let maxNote = DEFAULT_MAX_NOTE_CHARS;
  let maxOut = DEFAULT_MAX_TEST_OUTPUT_CHARS;
  const sources: string[] = [];
  for (const f of files) {
    const c = readConfig(f);
    if (!c) continue;
    sources.push(f);
    for (const p of c.redaction?.patterns ?? []) rules.push(compile(f, p));
    for (const g of c.sensitivePaths ?? []) sensitive.push(globToRegExp(g));
    if (c.test) allow.push(c.test.allow.map((e) => e.trim().split(/\s+/).filter(Boolean)));
    if (c.caps?.maxNoteChars !== undefined) maxNote = Math.min(maxNote, c.caps.maxNoteChars);
    if (c.caps?.maxTestOutputChars !== undefined) maxOut = Math.min(maxOut, c.caps.maxTestOutputChars);
  }
  registerPolicyRules(root, rules, sensitive);
  const policy: Policy = {
    testAllow: allow,
    maxNoteChars: maxNote,
    maxTestOutputChars: maxOut,
    sources,
    stamp,
  };
  cache.set(root, policy);
  return policy;
}

/** True when `argv` starts with every token of at least one entry of EACH allowlist (no allowlist = allowed). */
export function isCommandAllowed(policy: Policy, argv: readonly string[]): boolean {
  return policy.testAllow.every((list) => list.some((tokens) => tokens.length > 0 && tokens.length <= argv.length && tokens.every((t, i) => argv[i] === t)));
}

export const SAMPLE_CONFIG: PcsConfig = {
  redaction: { patterns: [{ name: "acme-key", pattern: "ACME-[A-Z0-9]{12}" }] },
  sensitivePaths: ["**/secrets/**", "*.vault"],
  test: { allow: ["npm test", "npx vitest", "node --test"] },
  caps: { maxNoteChars: 1000, maxTestOutputChars: 4000 },
};

export function initConfig(root: string): string {
  const file = projectConfigPath(root);
  if (existsSync(file)) throw new PcsError("INVALID_INPUT", `Config already exists: ${file}`);
  writeFileSync(file, `${JSON.stringify(SAMPLE_CONFIG, null, 2)}\n`);
  return file;
}

export function describePolicy(root: string): { sources: string[]; policy: Policy; files: { global: string; project: string } } {
  const policy = loadPolicy(root);
  return { sources: policy.sources, policy, files: { global: globalConfigPath(), project: projectConfigPath(root) } };
}
