import { Command } from "commander";
import { exitCodeFor, getStatus, initProject, verifyProject, type Status } from "../core";

/** Repo-controlled strings (paths, commit subjects) can carry terminal escape sequences. */
function safe(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
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
    integrity.ok
      ? `Log:     OK (${integrity.count} events, hash chain verified)`
      : `Log:     INTEGRITY FAILURE at event #${integrity.brokenAt}: ${integrity.reason}`,
  ];
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
  .description("Show the actual project state from git")
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

program.parseAsync().catch((err: unknown) => {
  console.error(`pcs: ${err instanceof Error ? safe(err.message) : "unexpected error"}`);
  process.exit(exitCodeFor(err));
});
