import { prisma } from "@payments/db/client";

// Honor an idempotency key for 24h, then it's reclaimable (D2). The batch size keeps
// each DELETE small so a large backlog never holds a long lock or spikes WAL at once.
const RETENTION_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 1000;

/**
 * Deletes idempotency records older than the retention window, in bounded batches so a
 * large backlog can't hold a long lock or bloat WAL in a single statement. Re-runnable:
 * a run with nothing expired removes zero. Returns the total number removed.
 */
export const reapExpiredRecords = async (
  batchSize: number = BATCH_SIZE,
): Promise<number> => {
  const expiry = new Date(Date.now() - RETENTION_MS);
  let totalDeleted = 0;

  for (;;) {
    // Postgres DELETE has no LIMIT, so limit a subquery of physical row ids (ctid) and
    // delete exactly those. $executeRaw returns the affected-row count for this batch.
    const deleted = await prisma.$executeRaw`
      DELETE FROM "IdempotencyRecord"
      WHERE ctid IN (
        SELECT ctid FROM "IdempotencyRecord"
        WHERE "createdAt" < ${expiry}
        LIMIT ${batchSize}
      )
    `;
    totalDeleted += deleted;
    if (deleted < batchSize) break; // a partial batch → the eligible rows are drained
  }

  return totalDeleted;
};
