// Run as a separate process by tests/concurrency.test.ts: one "agent" writing to the shared project.
import { addNote, addTask, updateTask } from "../../src/core";

const [dir, label, countArg] = process.argv.slice(2);
const count = Number(countArg);
const errors: string[] = [];
let written = 0;

for (let i = 0; i < count; i++) {
  try {
    await addNote(dir as string, "next", `${label} note ${i}`, label);
    written++;
    if (i % 5 === 0) {
      const t = await addTask(dir as string, `${label} task ${i}`, label);
      await updateTask(dir as string, t.id, { status: "done", source: label });
      written += 2;
    }
  } catch (e) {
    errors.push((e as Error).message);
  }
}

process.stdout.write(`${JSON.stringify({ label, written, errors })}\n`);
