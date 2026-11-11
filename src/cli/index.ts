import { Command } from "commander";
import { getStatus, initProject, type Status } from "../core";

function formatStatus(s: Status): string {
  const { project, git } = s;
  const lines = [`Project: ${project.name}`, `Root:    ${project.root}`, `Branch:  ${git.branch}`];
  lines.push(
    git.head
      ? `HEAD:    ${git.head.hash.slice(0, 7)} ${git.head.subject} (${git.head.date})`
      : "HEAD:    (no commits yet)",
  );
  lines.push("", `Changed files (${git.changed.length}):`);
  if (git.changed.length === 0) lines.push("  (working tree clean)");
  for (const f of git.changed) {
    const tag = f.untracked ? "??" : `${f.index}${f.worktree}`.replace(/ /g, "_");
    lines.push(`  ${tag}  ${f.path}`);
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
        ? `Already initialized: ${project.name}`
        : `Initialized PCS for ${project.name} (.pcs/)`,
    );
  });

program
  .command("status")
  .description("Show the actual project state from git")
  .option("--json", "output JSON")
  .action(async (opts: { json?: boolean }) => {
    const s = await getStatus(process.cwd());
    console.log(opts.json ? JSON.stringify(s, null, 2) : formatStatus(s));
  });

program.parseAsync().catch((err: unknown) => {
  console.error(`pcs: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
