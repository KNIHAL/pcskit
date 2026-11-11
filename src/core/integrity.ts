import type { Db } from "./db";
import { verifyChain, type ChainReport } from "./events";
import { verifySnapshots } from "./snapshots";

/** Full integrity check: the event hash chain, then every snapshot against its chained digest. */
export function verifyIntegrity(db: Db): ChainReport {
  const chain = verifyChain(db);
  if (!chain.ok) return chain;
  const snapshots = verifySnapshots(db);
  return snapshots.ok ? chain : { ...snapshots, count: chain.count };
}
