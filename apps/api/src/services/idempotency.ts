import { Prisma, prisma } from "@payments/db/client";
import { createHash } from "node:crypto";
import { ConflictError } from "../errors/index.js";

export async function runIdempotent<T extends unknown[], R>(
  userId: string,
  idempotencyKey: string,
  operation: (txn: Prisma.TransactionClient, ...args: T) => Promise<R>,
  ...args: T
): Promise<R> {
  // Deterministic fingerprint of the REQUEST. We hash the incoming args (never a jsonb
  // round-trip), so the comparison is reorder-proof; sha256 is fast + deterministic.
  const requestHash = createHash("sha256")
    .update(JSON.stringify(args))
    .digest("hex");

  return prisma.$transaction(async (txn) => {
    // Claim the key. `skipDuplicates` → INSERT … ON CONFLICT DO NOTHING: no error is
    // raised, so the transaction stays healthy. count === 1 means we won the claim.
    const { count } = await txn.idempotencyRecord.createMany({
      skipDuplicates: true,
      data: { userId, idempotencyKey, requestHash },
    });

    // Duplicate: the key was already claimed (a concurrent owner blocks us here until it
    // commits, so by now its response is recorded).
    if (!count) {
      const record = await txn.idempotencyRecord.findUnique({
        select: { requestHash: true, response: true },
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
      });
      // record is guaranteed present — a skipped insert means the row already exists.
      if (!record || record.requestHash !== requestHash) {
        throw new ConflictError("key reused for a different request");
      }
      // Replay the original RESULT (not a hash) — parsed back to the operation's shape.
      return JSON.parse(record.response ?? "null") as R;
    }

    // First time: we own the key. Run the operation on the SAME txn (so the side effect
    // is atomic with the claim), then record its result for future replays.
    const result = await operation(txn, ...args);
    await txn.idempotencyRecord.update({
      data: { response: JSON.stringify(result) },
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
    });
    return result;
  });
}
