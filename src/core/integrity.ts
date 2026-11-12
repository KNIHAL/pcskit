import type { Db } from "./db";
import { verifyChain, type ChainReport } from "./events";
import { verifySnapshots } from "./snapshots";
import { verifyTestRuns } from "./testruns";

/** Full integrity check: the event hash chain, then every snapshot and test run against its chained digest. */
export function verifyIntegrity(db: Db): ChainReport {
  const chain = verifyChain(db);
  if (!chain.ok) return chain;
  const snapshots = verifySnapshots(db);
  if (!snapshots.ok) return { ...snapshots, count: chain.count };
  const runs = verifyTestRuns(db);
  return runs.ok ? chain : { ...runs, count: chain.count };
}
