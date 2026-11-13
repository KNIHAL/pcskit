import { Command } from "commander";
import {
  addNote,
  addTask,
  createHandoff,
  listNotes,
  resolveNote,
  resume,
  formatArgv,
  PcsError,
  requestStop,
  startWatcher,
  watcherState,
  getTaskEvidence,
  getTestRun,
  linkEvidence,
  listTestRuns,
  runTest,
  compareSnapshots,
  currentSession,
  endSession,
  exitCodeFor,
  getStatus,
  initProject,
  listSessions,
  listSnapshots,
  listTasks,
  startSession,
  takeSnapshot,
  updateTask,
  verifyProject,
  type ChainReport,
  type Session,
  type Snapshot,
  type SnapshotComparison,
  type SnapshotFile,
  type Status,
  type Note,
  type Task,
  type TestRun,
} from "../core";

/** Repo-controlled strings (paths, commit subjects, titles) can carry terminal escape sequences. */
function safe(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

function formatTask(t: Task): string {
  return `#${t.id} [${t.status}] ${safe(t.title)}`;
}

function formatSession(s: Session): string {
  const state = s.ended_at ? `ended ${s.ended_at} (${s.end_reason})` : "ACTIVE";
  return `#${s.id} ${safe(s.agent)}  started ${s.started_at}  ${state}`;
}

function short(hash: string | null): string {
  return hash ? hash.slice(0, 7) : "(none)";
}

function formatSnapshotLine(s: Snapshot | null, failedMessage: string): string {
  return s
    ? `Snapshot #${s.id} (${s.kind}): HEAD ${short(s.head)}, ${s.files.length} changed file(s)${s.truncated ? " [truncated]" : ""}`
    : failedMessage;
}

function integrityLine(i: ChainReport): string {
  return i.ok
    ? `OK (${i.count} events, hash chain and snapshots verified)`
    : `INTEGRITY FAILURE${i.brokenAt !== undefined ? ` at event #${i.brokenAt}` : ""}: ${i.reason}`;
}

function formatStatus(s: Status): string {
  const { project, git, integrity } = s;
  const lines = [
    `Project: ${safe(project.name)}`,
    `Root:    ${safe(project.root)}`,
    `Branch:  ${safe(git.branch)}`,
    git.head
      ? `HEAD:    ${git.head.hash.slice(0, 7)} ${safe(git.head.subject)} (${git.head.date})`
      : "HEAD:    (no commits yet)",
    s.session
      ? `Session: #${s.session.id} ${safe(s.session.agent)} (since ${s.session.started_at})`
      : "Session: (none active)",
    `Watcher: ${s.watcher.running ? `running (pid ${s.watcher.pid})` : s.watcher.stale ? "not running (previous one died)" : "not running"}`,
    `Log:     ${integrityLine(integrity)}`,
  ];
  lines.push("", `Open tasks (${s.openTasks.length}):`);
  if (s.openTasks.length === 0) lines.push("  (none)");
  for (const t of s.openTasks) lines.push(`  ${formatTask(t)}`);

  lines.push("", `Changed files (${git.changed.length}):`);
  if (git.changed.length === 0) lines.push("  (working tree clean)");
  for (const f of git.changed) {
    const tag = f.untracked ? "??" : `${f.index}${f.worktree}`.replace(/ /g, "_");
    lines.push(`  ${tag}  ${safe(f.path)}${f.sensitive ? "  [sensitive: content never included]" : ""}`);
  }
  return lines.join("\n");
}

function fileTag(f: SnapshotFile): string {
  if (f.sensitive) return " [sensitive: name only]";
  if (f.kind === "missing") return " [deleted]";
  if (f.note === "too-large") return " [too large to hash]";
  return "";
}

function formatComparison(c: SnapshotComparison): string {
  const lines = [
    `Snapshot #${c.from} -> #${c.to}  (all of this was observed by PCS)`,
    `Branch: ${safe(c.branch.from)}${c.branch.changed ? ` -> ${safe(c.branch.to)}` : " (unchanged)"}`,
    `HEAD:   ${short(c.head.from)}${c.head.changed ? ` -> ${short(c.head.to)}` : " (unchanged)"}`,
  ];
  if (c.incomplete) lines.push("Note: a snapshot hit the file cap; lists below may be incomplete.");
  if (c.historyNote) lines.push(`Note: ${c.historyNote}`);

  lines.push("", `Commits made (${c.commits.length}):`);
  if (c.commits.length === 0) lines.push("  (none)");
  for (const k of c.commits) lines.push(`  ${short(k.hash)} ${safe(k.subject)}`);

  if (c.committedFiles.length > 0) {
    lines.push("", `Files changed by those commits (${c.committedFiles.length}):`);
    for (const f of c.committedFiles) lines.push(`  ${safe(f.status)}  ${safe(f.path)}`);
  }

  lines.push("", `New uncommitted changes (${c.added.length}):`);
  if (c.added.length === 0) lines.push("  (none)");
  for (const f of c.added) lines.push(`  ${safe(f.path)}${fileTag(f)}`);

  lines.push("", `Changed again since (${c.modified.length}):`);
  if (c.modified.length === 0) lines.push("  (none)");
  for (const m of c.modified) {
    const why = [m.contentChanged ? "content" : "", m.statusChanged ? "git status" : ""].filter(Boolean).join(" + ");
    lines.push(`  ${safe(m.path)}  (${why})${fileTag(m.after)}`);
  }

  lines.push("", `No longer differ from HEAD (committed, reverted or stashed) (${c.resolved.length}):`);
  if (c.resolved.length === 0) lines.push("  (none)");
  for (const f of c.resolved) lines.push(`  ${safe(f.path)}`);

  lines.push("", `Unchanged between snapshots: ${c.unchanged}`);
  return lines.join("\n");
}

const program = new Command();
program.name("pcs").description("Project Continuity System").version("0.1.0");

program
  .command("init")
  .description("Register the current git project with PCS")
  .action(async () => {
    const { project, alreadyInitialized } = await initProject(process.cwd());
    console.log(
      alreadyInitialized
        ? `Already initialized: ${safe(project.name)}`
        : `Initialized PCS for ${safe(project.name)} (.pcs/)`,
    );
  });

program
  .command("status")
  .description("Show the actual project state from git, plus session and open tasks")
  .option("--json", "output JSON")
  .action(async (opts: { json?: boolean }) => {
    const s = await getStatus(process.cwd());
    console.log(opts.json ? JSON.stringify(s, null, 2) : formatStatus(s));
    if (!s.integrity.ok) process.exitCode = 2;
  });

program
  .command("verify")
  .description("Verify the event log and snapshots are untampered")
  .action(async () => {
    const r = await verifyProject(process.cwd());
    if (r.ok) {
      console.log(`Integrity ${integrityLine(r)}`);
    } else {
      console.error(integrityLine(r));
      process.exitCode = 2;
    }
  });

const session = program.command("session").description("Track which AI agent is working");

session
  .command("start")
  .description("Start a session (a session left open is marked interrupted) and snapshot the repo")
  .requiredOption("--agent <name>", "agent name, e.g. claude, gpt, codex")
  .action(async (opts: { agent: string }) => {
    const { session: s, interrupted, snapshot } = await startSession(process.cwd(), opts.agent);
    if (interrupted) {
      console.log(`Previous session #${interrupted.id} (${safe(interrupted.agent)}) was never ended; marked interrupted.`);
    }
    console.log(`Started session #${s.id} (${safe(s.agent)})`);
    console.log(formatSnapshotLine(snapshot, "Snapshot failed (recorded in the log); session started anyway."));
  });

session
  .command("end")
  .description("End the active session and snapshot the repo")
  .option("--reason <reason>", "completed | limit | switched", "completed")
  .option("--note <text>", "short note, e.g. where you stopped")
  .action(async (opts: { reason: string; note?: string }) => {
    const s = await endSession(process.cwd(), opts);
    console.log(`Ended session #${s.id} (${safe(s.agent)}): ${s.end_reason}`);
    console.log(formatSnapshotLine(s.snapshot, "Snapshot failed (recorded in the log)."));
  });

session
  .command("current")
  .description("Show the active session")
  .action(async () => {
    const s = await currentSession(process.cwd());
    console.log(s ? formatSession(s) : "(no active session)");
  });

session
  .command("list")
  .description("List recent sessions")
  .option("--limit <n>", "how many", "20")
  .option("--json", "output JSON")
  .action(async (opts: { limit: string; json?: boolean }) => {
    const list = await listSessions(process.cwd(), Number(opts.limit));
    if (opts.json) console.log(JSON.stringify(list, null, 2));
    else if (list.length === 0) console.log("(no sessions)");
    else for (const s of list) console.log(formatSession(s));
  });

const snapshot = program.command("snapshot").description("Verified snapshots of the repo state");

snapshot
  .command("take", { isDefault: true })
  .description("Record a snapshot now (git state + content hashes of changed files)")
  .action(async () => {
    const s = await takeSnapshot(process.cwd());
    console.log(formatSnapshotLine(s, ""));
  });

snapshot
  .command("list")
  .description("List recent snapshots")
  .option("--limit <n>", "how many", "20")
  .option("--json", "output JSON")
  .action(async (opts: { limit: string; json?: boolean }) => {
    const list = await listSnapshots(process.cwd(), Number(opts.limit));
    if (opts.json) console.log(JSON.stringify(list, null, 2));
    else if (list.length === 0) console.log("(no snapshots)");
    else {
      for (const s of list) {
        const sess = s.session_id === null ? "no session" : `session #${s.session_id}`;
        console.log(`#${s.id} ${s.kind}  ${s.taken_at}  ${safe(s.branch)} @ ${short(s.head)}  ${s.fileCount} file(s)  ${sess}`);
      }
    }
  });

snapshot
  .command("diff [from] [to]")
  .description("Compare two snapshots (default: the last two) and show commits made in between")
  .option("--session <id>", "compare the first and last snapshot of a session")
  .option("--json", "output JSON")
  .action(async (from: string | undefined, to: string | undefined, opts: { session?: string; json?: boolean }) => {
    const c = await compareSnapshots(process.cwd(), {
      from: from === undefined ? undefined : Number(from),
      to: to === undefined ? undefined : Number(to),
      session: opts.session === undefined ? undefined : Number(opts.session),
    });
    console.log(opts.json ? JSON.stringify(c, null, 2) : formatComparison(c));
  });

const task = program.command("task").description("Track tasks (status changes are recorded as reported events)");

task
  .command("add <title...>")
  .description("Add a task")
  .option("--agent <name>", "who is reporting this (default: active session's agent, else user)")
  .action(async (title: string[], opts: { agent?: string }) => {
    const t = await addTask(process.cwd(), title.join(" "), opts.agent);
    console.log(`Added ${formatTask(t)}`);
  });

task
  .command("list")
  .description("List tasks")
  .option("--status <status>", "todo | in_progress | done | blocked")
  .option("--json", "output JSON")
  .action(async (opts: { status?: string; json?: boolean }) => {
    const tasks = await listTasks(process.cwd(), opts.status);
    const evidence = await getTaskEvidence(process.cwd());
    if (opts.json) console.log(JSON.stringify(tasks, null, 2));
    else if (tasks.length === 0) console.log("(no tasks)");
    else {
      for (const t of tasks) {
        const e = evidence[t.id];
        console.log(formatTask(t) + (e ? `  [evidence: run #${e.run_id} ${e.outcome}]` : ""));
      }
    }
  });

task
  .command("update <id>")
  .description("Change a task's status")
  .requiredOption("--status <status>", "todo | in_progress | done | blocked")
  .option("--note <text>", "short note about the change")
  .option("--agent <name>", "who is reporting this (default: active session's agent, else user)")
  .action(async (id: string, opts: { status: string; note?: string; agent?: string }) => {
    const t = await updateTask(process.cwd(), Number(id), {
      status: opts.status,
      note: opts.note,
      source: opts.agent,
    });
    console.log(`Updated ${formatTask(t)}`);
  });

/** Multi-line text from storage: keep newlines and tabs, drop everything else a terminal could act on. */
function safeText(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "?");
}

function formatCommand(argv: string[]): string {
  return safe(formatArgv(argv));
}

function describeExit(r: TestRun): string {
  if (r.outcome === "timeout") return "timed out";
  if (r.exit_code !== null) return `exit ${r.exit_code}`;
  return r.signal ? `signal ${safe(r.signal)}` : "no exit code";
}

program
  .command("test")
  .description("Run a command and record its result as verified evidence (put the command after --)")
  .argument("<command...>", "command and arguments, e.g. -- npm test")
  .option("--task <id>", "link this run to a task as evidence")
  .option("--timeout <seconds>", "kill the command after this long", "600")
  .option("--agent <name>", "who links the evidence (default: active session's agent, else user)")
  .action(async (command: string[], opts: { task?: string; timeout: string; agent?: string }) => {
    const { run: r, linkedTask } = await runTest(process.cwd(), command, {
      ...(opts.task !== undefined ? { taskId: Number(opts.task) } : {}),
      ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
      timeoutMs: Math.round(Number(opts.timeout) * 1000),
      onOutput: (text, stream) => {
        (stream === "stderr" ? process.stderr : process.stdout).write(text);
      },
    });
    console.log(
      `\nRun #${r.id} ${r.outcome.toUpperCase()} (${describeExit(r)}, ${(r.duration_ms / 1000).toFixed(1)}s): recorded as verified evidence`,
    );
    console.log(
      `Repo state: HEAD ${short(r.head)}, fingerprint ${r.tree_fingerprint ? r.tree_fingerprint.slice(0, 12) : "(not observed)"}`,
    );
    if (r.output_truncated) console.log("Note: only the last part of the output was stored.");
    if (linkedTask !== null) console.log(`Linked to task #${linkedTask}`);
    if (r.outcome !== "passed") process.exitCode = 1;
  });

const evidence = program.command("evidence").description("Verified test runs and the tasks they back");

evidence
  .command("list")
  .description("List recent test runs")
  .option("--limit <n>", "how many", "20")
  .option("--json", "output JSON")
  .action(async (opts: { limit: string; json?: boolean }) => {
    const list = await listTestRuns(process.cwd(), Number(opts.limit));
    if (opts.json) console.log(JSON.stringify(list, null, 2));
    else if (list.length === 0) console.log("(no test runs)");
    else {
      for (const r of list) {
        const sess = r.session_id === null ? "no session" : `session #${r.session_id}`;
        const code = r.exit_code === null ? "-" : String(r.exit_code);
        console.log(
          `#${r.id} ${r.outcome.padEnd(7)} exit ${code}  ${(r.duration_ms / 1000).toFixed(1)}s  ${r.ts}  @ ${short(r.head)}  ${sess}  ${formatCommand(r.argv)}`,
        );
      }
    }
  });

evidence
  .command("show <id>")
  .description("Show one test run with its stored output")
  .option("--json", "output JSON")
  .action(async (id: string, opts: { json?: boolean }) => {
    const r = await getTestRun(process.cwd(), Number(id));
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    console.log(`Run #${r.id}: ${r.outcome.toUpperCase()} (${describeExit(r)}, ${(r.duration_ms / 1000).toFixed(1)}s)  [verified: PCS ran it]`);
    console.log(`Command: ${formatCommand(r.argv)}${r.cwd ? `  (in ${safe(r.cwd)})` : ""}`);
    console.log(`Started: ${r.ts}  HEAD ${short(r.head)}  fingerprint ${r.tree_fingerprint ? r.tree_fingerprint.slice(0, 12) : "(not observed)"}`);
    console.log(`Output (${r.output_truncated ? "last part of " : ""}${r.output_bytes} bytes, redacted):`);
    console.log(safeText(r.output));
  });

evidence
  .command("link <task> <run>")
  .description("Point a task at a test run as evidence")
  .option("--agent <name>", "who is linking (default: active session's agent, else user)")
  .action(async (task: string, run: string, opts: { agent?: string }) => {
    await linkEvidence(process.cwd(), Number(task), Number(run), opts.agent);
    console.log(`Linked run #${Number(run)} to task #${Number(task)}`);
  });

function formatNote(n: Note): string {
  const state = n.resolved_at ? `  (resolved by ${safe(n.resolved_by ?? "?")} ${n.resolved_at})` : "";
  return `#${n.id} [${n.kind}] ${safe(n.source)}: ${safe(n.text)}${state}`;
}

const note = program
  .command("note")
  .description("Record what the next agent must know (stored as reported claims in the event log)");

note
  .command("add <kind> <text...>")
  .description("kind: task (what we are building) | next (an exact next step) | avoid (do not touch, and why) | issue (known problem)")
  .option("--agent <name>", "who is reporting this (default: active session's agent, else user)")
  .action(async (kind: string, text: string[], opts: { agent?: string }) => {
    const n = await addNote(process.cwd(), kind, text.join(" "), opts.agent);
    console.log(`Added ${formatNote(n)}`);
  });

note
  .command("list")
  .description("List notes (unresolved by default)")
  .option("--kind <kind>", "task | next | avoid | issue")
  .option("--all", "include resolved notes")
  .option("--json", "output JSON")
  .action(async (opts: { kind?: string; all?: boolean; json?: boolean }) => {
    const list = await listNotes(process.cwd(), {
      ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
      ...(opts.all ? { all: true } : {}),
    });
    if (opts.json) console.log(JSON.stringify(list, null, 2));
    else if (list.length === 0) console.log("(no notes)");
    else for (const n of list) console.log(formatNote(n));
  });

note
  .command("resolve <id>")
  .description("Mark a next/avoid/issue note as no longer applicable")
  .option("--agent <name>", "who is resolving it (default: active session's agent, else user)")
  .action(async (id: string, opts: { agent?: string }) => {
    const n = await resolveNote(process.cwd(), Number(id), opts.agent);
    console.log(`Resolved ${formatNote(n)}`);
  });

program
  .command("handoff")
  .description("Write a handoff for the next agent (.pcs/HANDOFF.md): verified, reported and inferred facts kept apart")
  .option("--session <id>", "whose work to hand off (default: the latest session)")
  .option("--out <file>", "write here instead of .pcs/HANDOFF.md")
  .option("--stdout", "print the handoff instead of writing a file")
  .option("--json", "print the structured handoff as JSON instead of writing a file")
  .action(async (opts: { session?: string; out?: string; stdout?: boolean; json?: boolean }) => {
    const toTerminal = opts.stdout === true || opts.json === true;
    const { handoff, markdown, path } = await createHandoff(process.cwd(), {
      ...(opts.session !== undefined ? { session: Number(opts.session) } : {}),
      ...(opts.out !== undefined ? { out: opts.out } : {}),
      noFile: toTerminal,
    });
    if (opts.json) console.log(JSON.stringify(handoff, null, 2));
    else if (opts.stdout) console.log(safeText(markdown));
    else {
      console.log(`Handoff written to ${safe(path ?? "")} (${Buffer.byteLength(markdown)} bytes)`);
      console.log(
        `Completed: ${handoff.tasks.verified.length} verified, ${handoff.tasks.reportedOnly.length + handoff.tasks.stale.length} not verified. In progress: ${handoff.tasks.inProgress.length}. Unresolved issues: ${handoff.issues.length}.`,
      );
      if (!handoff.originalTask) console.log('Tip: record the original task with `pcs note add task "..."`.');
      if (handoff.nextSteps.length === 0) console.log('Tip: record exact next steps with `pcs note add next "..."`.');
    }
    if (!handoff.integrity.ok) process.exitCode = 2;
  });

program
  .command("resume")
  .description("Pick up the latest handoff: check it, snapshot the repo, print the brief and record the pickup")
  .option("--agent <name>", "who is picking up; starts a session for them (default: the active session's agent)")
  .option("--json", "output JSON")
  .action(async (opts: { agent?: string; json?: boolean }) => {
    const r = await resume(process.cwd(), opts.agent !== undefined ? { agent: opts.agent } : {});
    if (opts.json) console.log(JSON.stringify(r, null, 2));
    else console.log(safeText(r.brief));
    if (!r.checks.integrity.ok) process.exitCode = 2;
  });

program
  .command("watch")
  .description("Watch the project and snapshot it when files or HEAD change, so a stopped agent's last work is recorded")
  .option("--stop", "ask the running watcher to stop")
  .option("--status", "show whether a watcher is running")
  .option("--debounce <seconds>", "quiet time before a snapshot is taken (default 2)")
  .option("--stalled <minutes>", "report a stalled session after this much inactivity (default 10)")
  .action(async (opts: { stop?: boolean; status?: boolean; debounce?: string; stalled?: string }) => {
    const cwd = process.cwd();
    if (opts.status) {
      const s = await watcherState(cwd);
      console.log(
        s.running
          ? `Watcher running (pid ${s.pid}, since ${s.startedAt}).`
          : s.stale
            ? "Watcher is not running (a previous one died; its lock is stale)."
            : "Watcher is not running.",
      );
      return;
    }
    if (opts.stop) {
      const r = await requestStop(cwd);
      console.log(r.requested ? "Stop requested; the watcher will exit within a few seconds." : "No watcher is running.");
      return;
    }
    const num = (v: string | undefined, unit: number, name: string): number | undefined => {
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new PcsError("INVALID_INPUT", `${name} must be a positive number.`);
      return Math.round(n * unit);
    };
    const debounceMs = num(opts.debounce, 1000, "--debounce");
    const stalledMs = num(opts.stalled, 60_000, "--stalled");
    const w = await startWatcher(cwd, {
      ...(debounceMs !== undefined ? { debounceMs } : {}),
      ...(stalledMs !== undefined ? { stalledMs } : {}),
      onLog: (line) => console.log(`[pcs watch] ${safe(line)}`),
    });
    const quit = () => void w.stop("interrupted by user");
    process.once("SIGINT", quit);
    process.once("SIGTERM", quit);
    await w.ready;
    console.log("Press Ctrl+C or run `pcs watch --stop` to stop.");
    await w.done;
  });

program
  .command("mcp")
  .description("Run PCS as an MCP server over stdio, so agents can call pcs tools themselves")
  .option("--project <dir>", "project directory (default: the current directory)")
  .option("--agent <name>", "default agent name recorded on writes")
  .option("--allow-test", "also expose pcs_test, which runs commands on this machine (off by default)")
  .action(async (opts: { project?: string; agent?: string; allowTest?: boolean }) => {
    const project = opts.project ?? process.cwd();
    await getStatus(project); // fail early (to stderr) if this is not an initialized PCS project
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { createMcpServer } = await import("../mcp/server");
    const server = createMcpServer({
      project,
      ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
      ...(opts.allowTest ? { allowTest: true } : {}),
    });
    await server.connect(new StdioServerTransport());
    console.error(`pcs mcp: serving ${safe(project)}${opts.allowTest ? " (pcs_test enabled)" : ""}`);
  });

program.parseAsync().catch((err: unknown) => {
  console.error(`pcs: ${err instanceof Error ? safe(err.message) : "unexpected error"}`);
  process.exit(exitCodeFor(err));
});
