import { Command } from "commander";
import {
  addTask,
  currentSession,
  endSession,
  exitCodeFor,
  getStatus,
  initProject,
  listSessions,
  listTasks,
  startSession,
  updateTask,
  verifyProject,
  type Session,
  type Status,
  type Task,
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
    integrity.ok
      ? `Log:     OK (${integrity.count} events, hash chain verified)`
      : `Log:     INTEGRITY FAILURE at event #${integrity.brokenAt}: ${integrity.reason}`,
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
  .description("Verify the event log is untampered (hash chain)")
  .action(async () => {
    const r = await verifyProject(process.cwd());
    if (r.ok) {
      console.log(`Integrity OK (${r.count} events)`);
    } else {
      console.error(`Integrity FAILED at event #${r.brokenAt}: ${r.reason}`);
      process.exitCode = 2;
    }
  });

const session = program.command("session").description("Track which AI agent is working");

session
  .command("start")
  .description("Start a session (a session left open is marked interrupted)")
  .requiredOption("--agent <name>", "agent name, e.g. claude, gpt, codex")
  .action(async (opts: { agent: string }) => {
    const { session: s, interrupted } = await startSession(process.cwd(), opts.agent);
    if (interrupted) {
      console.log(`Previous session #${interrupted.id} (${safe(interrupted.agent)}) was never ended; marked interrupted.`);
    }
    console.log(`Started session #${s.id} (${safe(s.agent)})`);
  });

session
  .command("end")
  .description("End the active session")
  .option("--reason <reason>", "completed | limit | switched", "completed")
  .option("--note <text>", "short note, e.g. where you stopped")
  .action(async (opts: { reason: string; note?: string }) => {
    const s = await endSession(process.cwd(), opts);
    console.log(`Ended session #${s.id} (${safe(s.agent)}): ${s.end_reason}`);
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
    if (opts.json) console.log(JSON.stringify(tasks, null, 2));
    else if (tasks.length === 0) console.log("(no tasks)");
    else for (const t of tasks) console.log(formatTask(t));
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

program.parseAsync().catch((err: unknown) => {
  console.error(`pcs: ${err instanceof Error ? safe(err.message) : "unexpected error"}`);
  process.exit(exitCodeFor(err));
});
