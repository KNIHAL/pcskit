import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addTask,
  buildCmdShimInvocation,
  getStatus,
  getTaskEvidence,
  getTestRun,
  initProject,
  linkEvidence,
  listTestRuns,
  MAX_OUTPUT_CHARS,
  PcsError,
  prepareInvocation,
  recentEvents,
  resolveWindowsExecutable,
  runTest,
  sanitizeOutput,
  startSession,
  verifyProject,
  withDb,
} from "../src/core";

let dir: string;

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

/** A node command as an argument array: works the same on Windows and Linux. */
const node = (script: string, ...extra: string[]) => [process.execPath, "-e", script, ...extra];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pcs-run-"));
  git("init", "-q");
  git("config", "user.email", "t@t.dev");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "x\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "init");
  await initProject(dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PcsError);
  expect((err as PcsError).code).toBe(code);
}

const events = () => withDb(dir, (db) => recentEvents(db, 100).reverse());

describe("pcs test: recording a run", () => {
  it("records a passed run as a verified event and keeps the chain valid", async () => {
    const { run } = await runTest(dir, node("console.log('hello'); console.error('warn')"));
    expect(run).toMatchObject({ outcome: "passed", exit_code: 0, signal: null, cwd: "", session_id: null });
    expect(run.output).toContain("hello");
    expect(run.output).toContain("warn");
    expect(run.head).toBe(git("rev-parse", "HEAD"));
    expect(run.tree_fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const evt = (await events()).find((e) => e.type === "test.run")!;
    expect(evt).toMatchObject({ provenance: "verified", source: "pcs" });
    expect(JSON.parse(evt.payload)).toMatchObject({ runId: run.id, outcome: "passed", digest: run.digest });
    expect(await verifyProject(dir)).toMatchObject({ ok: true });
    expect(await getTestRun(dir, run.id)).toEqual(run);
  });

  it("records a failing command with its exit code", async () => {
    const { run } = await runTest(dir, node("console.log('boom'); process.exit(3)"));
    expect(run).toMatchObject({ outcome: "failed", exit_code: 3 });
    expect(run.output).toContain("boom");
  });

  it("kills a command that exceeds the timeout and records it", async () => {
    const { run } = await runTest(dir, node("setInterval(() => {}, 1000)"), { timeoutMs: 400 });
    expect(run.outcome).toBe("timeout");
    expect(run.exit_code).toBeNull();
    expect(run.output).toContain("timed out");
    expect(await verifyProject(dir)).toMatchObject({ ok: true });
  });

  it("records a command that does not exist as an error, not a crash", async () => {
    const { run } = await runTest(dir, ["pcs-definitely-not-a-command-xyz"]);
    expect(run).toMatchObject({ outcome: "error", exit_code: null });
    expect(run.output).toContain("not found");
  });

  it("passes arguments literally: there is no shell to interpret them", async () => {
    const { run } = await runTest(dir, node("console.log(process.argv[1])", "a; echo pwned && whoami"));
    expect(run.output.trim()).toBe("a; echo pwned && whoami");
  });

  it("ties the run to the active session", async () => {
    const { session } = await startSession(dir, "claude");
    const { run } = await runTest(dir, node("0"));
    expect(run.session_id).toBe(session.id);
    const evt = (await events()).find((e) => e.type === "test.run")!;
    expect(evt.session_id).toBe(session.id);
  });

  it("runs in the invoking directory and records it relative to the repo root", async () => {
    mkdirSync(join(dir, "sub", "deep"), { recursive: true });
    const { run } = await runTest(join(dir, "sub", "deep"), node("console.log(process.cwd())"));
    expect(run.cwd).toBe("sub/deep");
    expect(run.output).toContain("deep");
  });

  it("streams sanitized output to the caller as it arrives", async () => {
    const seen: string[] = [];
    await runTest(dir, node("console.log('\\x1b[31mred\\x1b[0m')"), { onOutput: (t) => seen.push(t) });
    expect(seen.join("")).toBe("red\n");
  });

  it("redacts secrets in the live stream too, including a line split across writes", async () => {
    const script =
      "process.stdout.write('pass' + 'word=hunter2'); setTimeout(() => process.stdout.write('hunter2\\n'), 50); console.error('ghp_' + 'a1B2'.repeat(9))";
    const seen: string[] = [];
    await runTest(dir, node(script), { onOutput: (t) => seen.push(t) });
    const all = seen.join("");
    expect(all).not.toMatch(/hunter2|ghp_a1B2/);
    expect(all).toContain("[REDACTED:");
  });

  it("flushes a final line that has no newline", async () => {
    const seen: string[] = [];
    await runTest(dir, node("process.stdout.write('no newline at end')"), { onOutput: (t) => seen.push(t) });
    expect(seen.join("")).toBe("no newline at end");
  });
});

describe("pcs test: what is stored", () => {
  it("redacts secrets in output and arguments before storing", async () => {
    const script = "console.log('pass' + 'word=hunter2hunter2'); console.log('ghp_' + 'a1B2'.repeat(9))";
    const { run } = await runTest(dir, node(script, "--token=supersecretvalue99"));
    expect(run.output).not.toMatch(/hunter2|ghp_a1B2/);
    expect(run.output).toContain("[REDACTED:");
    expect(run.argv.join(" ")).not.toContain("supersecretvalue99");
    const stored = (await events()).map((e) => e.payload).join("");
    expect(stored).not.toContain("supersecretvalue99");
  });

  it("caps stored output at the tail and flags truncation", async () => {
    const { run } = await runTest(dir, node("process.stdout.write('x'.repeat(200000) + 'THE-END')"));
    expect(run.output.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(run.output.endsWith("THE-END")).toBe(true);
    expect(run.output_truncated).toBe(true);
    expect(run.output_bytes).toBeGreaterThanOrEqual(200000);
  });

  it("strips terminal escape sequences from stored output", async () => {
    const { run } = await runTest(dir, node("console.log('\\x1b[31mred\\x1b[0m \\x1b]0;title\\x07ok')"));
    expect(run.output).toBe("red ok\n");
  });

  it("fingerprints the tested repo state: same state same hash, changed files differ", async () => {
    const a = await runTest(dir, node("0"));
    const b = await runTest(dir, node("0"));
    expect(b.run.tree_fingerprint).toBe(a.run.tree_fingerprint);

    writeFileSync(join(dir, "a.txt"), "changed\n");
    const c = await runTest(dir, node("0"));
    expect(c.run.tree_fingerprint).not.toBe(a.run.tree_fingerprint);
    writeFileSync(join(dir, "a.txt"), "changed again\n");
    const d = await runTest(dir, node("0"));
    expect(d.run.tree_fingerprint).not.toBe(c.run.tree_fingerprint);
  });
});

describe("pcs test: evidence for tasks", () => {
  it("links a run to a task; the latest linked run is the task's evidence", async () => {
    await addTask(dir, "ship it");
    const ok = await runTest(dir, node("0"), { taskId: 1 });
    expect(ok.linkedTask).toBe(1);
    expect((await getTaskEvidence(dir))[1]).toMatchObject({ run_id: ok.run.id, outcome: "passed" });

    const bad = await runTest(dir, node("process.exit(1)"), { taskId: 1 });
    expect((await getTaskEvidence(dir))[1]).toMatchObject({ run_id: bad.run.id, outcome: "failed" });

    const link = (await events()).find((e) => e.type === "task.evidence_linked")!;
    expect(link.provenance).toBe("reported"); // which task a run backs is a claim; the run itself is verified
    expect(await verifyProject(dir)).toMatchObject({ ok: true });
  });

  it("attributes the link to the session's agent, or an explicit one", async () => {
    await addTask(dir, "t");
    await startSession(dir, "claude");
    await runTest(dir, node("0"), { taskId: 1 });
    await runTest(dir, node("0"), { taskId: 1, agent: "gpt" });
    const links = (await events()).filter((e) => e.type === "task.evidence_linked");
    expect(links.map((e) => e.source)).toEqual(["claude", "gpt"]);
  });

  it("links an existing run later, and refuses duplicates and unknown ids", async () => {
    await addTask(dir, "t");
    const { run } = await runTest(dir, node("0"));
    await linkEvidence(dir, 1, run.id);
    expect((await getTaskEvidence(dir))[1]?.run_id).toBe(run.id);
    await expectCode(linkEvidence(dir, 1, run.id), "INVALID_INPUT");
    await expectCode(linkEvidence(dir, 2, run.id), "INVALID_INPUT");
    await expectCode(linkEvidence(dir, 1, 99), "INVALID_INPUT");
    await expectCode(linkEvidence(dir, 0, 1), "INVALID_INPUT");
  });

  it("refuses an unknown task before running anything", async () => {
    const marker = join(dir, "ran.txt");
    await expectCode(
      runTest(dir, node("require('fs').writeFileSync(process.argv[1], 'x')", marker), { taskId: 99 }),
      "INVALID_INPUT",
    );
    expect(existsSync(marker)).toBe(false);
    expect(await listTestRuns(dir)).toHaveLength(0);
  });

  it("does not turn a task's 'done' into verified: status events stay reported", async () => {
    await addTask(dir, "t");
    await runTest(dir, node("0"), { taskId: 1 });
    expect((await events()).filter((e) => e.type.startsWith("task.") && e.provenance === "verified")).toHaveLength(0);
    expect((await getStatus(dir)).openTasks).toHaveLength(1);
  });
});

describe("pcs test: input validation", () => {
  it("rejects bad commands, timeouts, ids and agent names without recording anything", async () => {
    await expectCode(runTest(dir, []), "INVALID_INPUT");
    await expectCode(runTest(dir, [""]), "INVALID_INPUT");
    await expectCode(runTest(dir, ["node", "a\0b"]), "INVALID_INPUT");
    await expectCode(runTest(dir, ["x".repeat(5000)]), "INVALID_INPUT");
    await expectCode(runTest(dir, Array.from({ length: 101 }, () => "a")), "INVALID_INPUT");
    await expectCode(runTest(dir, node("0"), { timeoutMs: 0 }), "INVALID_INPUT");
    await expectCode(runTest(dir, node("0"), { timeoutMs: Number.NaN }), "INVALID_INPUT");
    await expectCode(runTest(dir, node("0"), { timeoutMs: 10 ** 12 }), "INVALID_INPUT");
    await expectCode(runTest(dir, node("0"), { taskId: 0 }), "INVALID_INPUT");
    await expectCode(runTest(dir, node("0"), { agent: "bad\nname" }), "INVALID_INPUT");
    await expectCode(getTestRun(dir, 5), "INVALID_INPUT");
    await expectCode(listTestRuns(dir, 0), "INVALID_INPUT");
    expect(await listTestRuns(dir)).toHaveLength(0);
  });

  it("requires init", async () => {
    const plain = mkdtempSync(join(tmpdir(), "pcs-noinit-"));
    execFileSync("git", ["init", "-q"], { cwd: plain, stdio: "ignore" });
    await expectCode(runTest(plain, node("0")), "NOT_INITIALIZED");
    rmSync(plain, { recursive: true, force: true });
  });
});

describe("pcs test: tamper evidence", () => {
  it("detects an edited run even if the triggers were dropped", async () => {
    const { run } = await runTest(dir, node("process.exit(1)"));
    await withDb(dir, (db) => {
      db.exec("DROP TRIGGER test_runs_no_update");
      db.exec(`UPDATE test_runs SET outcome = 'passed', exit_code = 0 WHERE id = ${run.id}`);
    });
    expect(await verifyProject(dir)).toMatchObject({ ok: false, reason: expect.stringMatching(/test run #1.*modified/) });
  });

  it("detects a deleted run", async () => {
    await runTest(dir, node("0"));
    await withDb(dir, (db) => {
      db.exec("DROP TRIGGER test_runs_no_delete");
      db.exec("DELETE FROM test_runs");
    });
    expect(await verifyProject(dir)).toMatchObject({ ok: false, reason: expect.stringMatching(/missing/) });
  });

  it("blocks edits and deletes while the triggers exist", async () => {
    await runTest(dir, node("0"));
    await withDb(dir, (db) => {
      expect(() => db.exec("UPDATE test_runs SET outcome = 'passed'")).toThrow(/immutable/);
      expect(() => db.exec("DELETE FROM test_runs")).toThrow(/immutable/);
    });
  });

  it("detects a forged evidence link and a removed one", async () => {
    await addTask(dir, "t");
    const { run } = await runTest(dir, node("process.exit(1)"));
    await withDb(dir, (db) => {
      db.exec("DROP TRIGGER task_evidence_no_delete");
      db.exec(`INSERT INTO task_evidence (task_id, run_id, ts) VALUES (1, ${run.id}, 'x')`);
    });
    expect(await verifyProject(dir)).toMatchObject({ ok: false, reason: expect.stringMatching(/forged/) });

    await withDb(dir, (db) => db.exec("DELETE FROM task_evidence"));
    expect(await verifyProject(dir)).toMatchObject({ ok: true });

    await linkEvidence(dir, 1, run.id);
    await withDb(dir, (db) => db.exec("DELETE FROM task_evidence"));
    expect(await verifyProject(dir)).toMatchObject({ ok: false, reason: expect.stringMatching(/removed/) });
  });
});

describe("runner helpers", () => {
  it("sanitizeOutput strips escapes and control characters but keeps newlines and tabs", () => {
    expect(sanitizeOutput("a\u001b[1;31mb\u001b[0m\tc\r\nd\re\u0000f\u007fg")).toBe("ab\tc\nd\nefg");
    expect(sanitizeOutput("x\u001b]8;;http://evil\u0007link\u001b]8;;\u0007")).toBe("xlink");
  });

  it("builds a cmd.exe invocation for .cmd shims and rejects syntax cmd would interpret", () => {
    const inv = buildCmdShimInvocation("C:\\Program Files\\nodejs\\npm.cmd", ["test", "--grep", "a b"], "cmd.exe");
    expect(inv).toEqual({
      file: "cmd.exe",
      args: ["/d", "/s", "/c", '""C:\\Program Files\\nodejs\\npm.cmd" test --grep "a b""'],
      verbatim: true,
    });
    for (const bad of ["a&b", "a|b", "a>b", "a<b", "a^b", "%PATH%", 'a"b', "a\nb"]) {
      expect(() => buildCmdShimInvocation("C:\\n\\npm.cmd", [bad])).toThrow(/unsafe/);
    }
  });

  it("resolves Windows executables via PATH only, preferring .exe, never the working directory", () => {
    const has = (...files: string[]) => (p: string) => files.includes(p);
    const env = { PATH: "C:\\a;C:\\b" };
    expect(resolveWindowsExecutable("npm", "C:\\w", env, has("C:\\b\\npm.cmd"))).toBe("C:\\b\\npm.cmd");
    expect(resolveWindowsExecutable("node", "C:\\w", env, has("C:\\b\\node.exe", "C:\\a\\node.cmd"))).toBe("C:\\a\\node.cmd");
    expect(resolveWindowsExecutable("npm", "C:\\w", env, has("C:\\w\\npm.cmd"))).toBeNull();
    expect(resolveWindowsExecutable("tool", "C:\\w", { Path: "C:\\a" }, has("C:\\a\\tool.exe"))).toBe("C:\\a\\tool.exe");
    expect(resolveWindowsExecutable(".\\bin\\tool", "C:\\w", env, has("C:\\w\\bin\\tool.exe"))).toBe("C:\\w\\bin\\tool.exe");
  });

  it("prepares invocations per platform", () => {
    const env = { PATH: "C:\\n", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
    const exists = (p: string) => ["C:\\n\\npm.cmd", "C:\\n\\node.exe"].includes(p);
    expect(prepareInvocation(["npm", "test"], "C:\\w", env, "win32", exists)).toMatchObject({
      file: "C:\\Windows\\System32\\cmd.exe",
      verbatim: true,
    });
    expect(prepareInvocation(["node", "x.js"], "C:\\w", env, "win32", exists)).toEqual({
      file: "C:\\n\\node.exe",
      args: ["x.js"],
      verbatim: false,
    });
    expect(prepareInvocation(["nope"], "C:\\w", env, "win32", exists)).toBeNull();
    expect(prepareInvocation(["npm", "test"], "/w", {}, "linux")).toEqual({ file: "npm", args: ["test"], verbatim: false });
  });
});
