import { execFile, spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { win32 } from "node:path";
import { PcsError } from "./errors";
import { redactText } from "./redact";

export const MAX_ARGS = 100;
export const MAX_ARG_CHARS = 4096;
export const MAX_ARGV_CHARS = 32768;
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
/** How much output is kept in memory while a command runs (the tail; failures show up at the end). */
export const CAPTURE_CHARS = 64 * 1024;
const KILL_GRACE_MS = 5000;

export type RunOutcome = "passed" | "failed" | "timeout" | "error";

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  onOutput?: ((text: string, stream: "stdout" | "stderr") => void) | undefined;
}

export interface RunResult {
  outcome: RunOutcome;
  /** null when the command never started, timed out, or was killed by a signal. */
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  /** Last part of the sanitized combined output (stdout and stderr, in arrival order). Not yet redacted. */
  tail: string;
  /** Sanitized characters seen in total (more than tail.length means output was cut). */
  totalChars: number;
  /** Raw bytes seen in total. */
  totalBytes: number;
  error?: string;
}

export interface Invocation {
  file: string;
  args: string[];
  /** Windows only: pass args exactly as given (used for the cmd.exe shim). */
  verbatim: boolean;
}

/** The command is an argument array, never a shell string. Reject anything odd before running. */
export function validateArgv(argv: readonly string[]): string[] {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new PcsError("INVALID_INPUT", "No command given. Usage: pcs test -- <command> [args...]");
  }
  if (argv.length > MAX_ARGS) throw new PcsError("INVALID_INPUT", `Too many arguments (max ${MAX_ARGS}).`);
  let total = 0;
  for (const a of argv) {
    if (typeof a !== "string") throw new PcsError("INVALID_INPUT", "Command arguments must be strings.");
    if (a.includes("\0")) throw new PcsError("INVALID_INPUT", "Command arguments cannot contain NUL characters.");
    if (a.length > MAX_ARG_CHARS) throw new PcsError("INVALID_INPUT", `An argument is longer than ${MAX_ARG_CHARS} characters.`);
    total += a.length;
  }
  if (total > MAX_ARGV_CHARS) throw new PcsError("INVALID_INPUT", `Command is longer than ${MAX_ARGV_CHARS} characters.`);
  if (argv[0]!.trim() === "") throw new PcsError("INVALID_INPUT", "Command name is empty.");
  return [...argv];
}

const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** Output of an untrusted repo may carry terminal escape sequences. Strip them; keep newlines and tabs. */
export function sanitizeOutput(s: string): string {
  return s.replace(OSC, "").replace(CSI, "").replace(/\r\n?/g, "\n").replace(CONTROL, "");
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

const EXEC_EXTS = [".exe", ".com", ".cmd", ".bat"];

/**
 * Find an executable the way Windows would, but only via PATH or an explicit path:
 * the working directory is never searched, so a planted file in a repo cannot hijack `npm`.
 */
export function resolveWindowsExecutable(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = isFile,
): string | null {
  const hasSep = /[\\/]/.test(command);
  const dirs = hasSep
    ? [""]
    : (envGet(env, "PATH") ?? "")
        .split(";")
        .map((d) => d.trim().replace(/^"|"$/g, ""))
        .filter((d) => d.length > 0);
  const ext = win32.extname(command).toLowerCase();
  const names = EXEC_EXTS.includes(ext) ? [command] : EXEC_EXTS.map((e) => command + e);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = hasSep ? win32.resolve(cwd, name) : win32.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

const CMD_UNSAFE = /[&|<>^%"\r\n\0]/;

/**
 * Node cannot start .cmd/.bat files without a shell. `npm` and `npx` are .cmd files on Windows,
 * so they go through cmd.exe, but only when no argument can be read by cmd as syntax.
 */
export function buildCmdShimInvocation(file: string, args: readonly string[], comspec = "cmd.exe"): Invocation {
  const quote = (s: string): string => {
    if (CMD_UNSAFE.test(s)) {
      throw new PcsError(
        "INVALID_INPUT",
        'This command runs through a Windows .cmd shim and an argument contains characters that are unsafe there (& | < > ^ % "). Run the .exe directly, or use `node <script>`.',
      );
    }
    return s === "" || /[\s()]/.test(s) ? `"${s}"` : s;
  };
  const line = [file, ...args].map(quote).join(" ");
  return { file: comspec, args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

export function prepareInvocation(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: string = process.platform,
  exists: (path: string) => boolean = isFile,
): Invocation | null {
  const [command, ...args] = argv as [string, ...string[]];
  if (platform !== "win32") return { file: command, args, verbatim: false };
  const found = resolveWindowsExecutable(command, cwd, env, exists);
  if (!found) return null;
  const ext = win32.extname(found).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    return buildCmdShimInvocation(found, args, envGet(env, "ComSpec") ?? "cmd.exe");
  }
  return { file: found, args, verbatim: false };
}

class Tail {
  private text = "";
  total = 0;
  constructor(private readonly limit: number) {}
  push(t: string): void {
    this.total += t.length;
    this.text += t;
    if (this.text.length > this.limit * 2) this.text = this.text.slice(-this.limit);
  }
  value(): string {
    return this.text.length > this.limit ? this.text.slice(-this.limit) : this.text;
  }
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL"); // whole process group (the child was started detached)
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run a command (argument array, no shell string) and capture a bounded tail of its output.
 * Never throws for a failing or missing command; that is reported as the outcome.
 * Throws PcsError only for input that must not be run (see buildCmdShimInvocation).
 */
export function runCommand(argv: readonly string[], opts: RunOptions): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const inv = prepareInvocation(argv, opts.cwd, env);
  const started = Date.now();
  const tail = new Tail(CAPTURE_CHARS);
  let bytes = 0;

  const result = (outcome: RunOutcome, exitCode: number | null, signal: string | null, error?: string): RunResult => ({
    outcome,
    exitCode,
    signal,
    durationMs: Date.now() - started,
    tail: tail.value(),
    totalChars: tail.total,
    totalBytes: bytes,
    ...(error ? { error } : {}),
  });

  if (!inv) {
    const msg = `command not found: ${sanitizeOutput(String(argv[0]))}`;
    tail.push(`pcs: ${msg}\n`);
    return Promise.resolve(result("error", null, null, msg));
  }

  return new Promise<RunResult>((resolvePromise) => {
    const child = spawn(inv.file, inv.args, {
      cwd: opts.cwd,
      env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: inv.verbatim,
      stdio: ["ignore", "pipe", "pipe"], // stdin closed: a test run must never wait for input
      detached: process.platform !== "win32",
    });

    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    // Live output is redacted line by line (a secret never straddles a line), so the
    // terminal does not show what the stored copy hides. A partial line is held until its newline.
    const pending = { stdout: "", stderr: "" };
    const MAX_PENDING = 4096;
    const forward = (stream: "stdout" | "stderr", flushAll: boolean): void => {
      if (!opts.onOutput) return;
      let buf = pending[stream];
      let cut = buf.lastIndexOf("\n") + 1;
      if (flushAll || buf.length - cut > MAX_PENDING) cut = buf.length;
      if (cut === 0) return;
      const out = redactText(buf.slice(0, cut)).text;
      pending[stream] = buf.slice(cut);
      opts.onOutput(out, stream);
    };
    const emit = (stream: "stdout" | "stderr", raw: string): void => {
      const text = sanitizeOutput(raw);
      if (!text) return;
      tail.push(text);
      pending[stream] += text;
      forward(stream, false);
    };
    const onData = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      bytes += chunk.length;
      emit(stream, decoders[stream].write(chunk));
    };
    child.stdout?.on("data", onData("stdout"));
    child.stderr?.on("data", onData("stderr"));

    let settled = false;
    let timedOut = false;
    let spawnError: string | null = null;
    let timer: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      emit("stdout", decoders.stdout.end());
      emit("stderr", decoders.stderr.end());
      forward("stdout", true);
      forward("stderr", true);
      if (spawnError) {
        tail.push(`pcs: ${spawnError}\n`);
        resolvePromise(result("error", null, null, spawnError));
      } else if (timedOut) {
        tail.push(`\npcs: timed out after ${opts.timeoutMs / 1000}s and was killed\n`);
        resolvePromise(result("timeout", null, signal ?? "SIGKILL"));
      } else {
        resolvePromise(result(code === 0 ? "passed" : "failed", code, signal));
      }
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      spawnError =
        err.code === "ENOENT"
          ? `command not found: ${sanitizeOutput(String(argv[0]))}`
          : `could not start command: ${sanitizeOutput(err.message)}`;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // If something still holds the output pipes open after the kill, stop waiting for them.
      grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null, "SIGKILL");
      }, KILL_GRACE_MS);
    }, opts.timeoutMs);
  });
}
