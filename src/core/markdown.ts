/**
 * Helpers for writing text that another AI will read. Most strings in a handoff come from places an
 * attacker or a confused agent controls (commit subjects, file names, notes, test output), so free
 * text goes inside inline code or a code fence, and control characters are stripped.
 */

export type Tag = "verified" | "reported" | "inferred";

export function oneLine(s: string, max = 300): string {
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function longestRun(s: string, ch: string): number {
  let best = 0;
  let cur = 0;
  for (const c of s) {
    cur = c === ch ? cur + 1 : 0;
    if (cur > best) best = cur;
  }
  return best;
}

/** Inline code that the text cannot break out of. */
export function code(s: string, max = 300): string {
  const t = oneLine(s, max);
  const fence = "`".repeat(longestRun(t, "`") + 1);
  const pad = t.startsWith("`") || t.endsWith("`") ? " " : "";
  return `${fence}${pad}${t}${pad}${fence}`;
}

/** A code fence longer than any backtick run inside the text. */
export function fenced(text: string): string {
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "?").trimEnd();
  const fence = "`".repeat(Math.max(3, longestRun(clean, "`") + 1));
  return `${fence}\n${clean}\n${fence}`;
}

export function tag(p: Tag, source?: string): string {
  if (p === "verified") return "[verified]";
  if (p === "inferred") return "[inferred]";
  return `[reported by ${oneLine(source ?? "unknown", 64)}]`;
}

export function short(hash: string | null): string {
  return hash ? hash.slice(0, 7) : "(none)";
}

export function cap<T>(items: T[], n: number): { shown: T[]; more: number } {
  return { shown: items.slice(0, n), more: Math.max(0, items.length - n) };
}

export function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** An argument list as a command line a reader can copy: anything but plain characters is JSON-quoted. */
export function formatArgv(argv: string[]): string {
  return argv.map((a) => (a === "" || /[^\w@%+=:,./\\-]/.test(a) ? JSON.stringify(a) : a)).join(" ");
}
