import { Prisma, prisma, TransactionOutbox } from "@payments/db/client";
import { BankTransferQueuePayload } from "@payments/types";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { Client } from "pg";
import { AppError } from "../errors/index.js";
import { producerRedis } from "../redis.js";
import { BANK_TRANSFER_QUEUE, requireRedisUrl } from "./queue.js";

const BATCH_SIZE = 200;
const MAX_PUBLISH_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 10 * 60_000;
// The claim holds row locks for the whole batch, so the txn has to outlive
// BATCH_SIZE round-trips to Redis — the 5s default would abort mid-drain.
const TXN_TIMEOUT_MS = 30_000;
// NOTIFY is best-effort (see the trigger migration), so the poll is not optional:
// it is what sweeps up rows whose notification was lost and rows leaving backoff.
const FALLBACK_POLL_MS = 5_000;

const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: 1_000,
  removeOnFail: false, // the failed set IS the dead-letter queue — never drop silently
} as const;

let connection: Redis | undefined;
let queue: Queue<BankTransferQueuePayload> | undefined;
let pgClient: Client | undefined;
let fallbackPoll: NodeJS.Timeout | undefined;

let draining = false;
let rerun = false;
let reconnecting = false;
let stopping = false;
let listenAttempts = 0;

type OutboxClaim = Pick<
  TransactionOutbox,
  "id" | "transactionId" | "type" | "amount" | "userId" | "attempts"
>;

type PoisonedRow = { row: OutboxClaim; cause: unknown };

/** Only `add` is used, so only `add` is required — tests can stand in without a Redis. */
export type OutboxPublisher = Pick<Queue<BankTransferQueuePayload>, "add">;

// Built on first use rather than at import: importing this module must not open a
// socket, or every test that only touches the outbox TABLE would need a Redis.
function outboxQueue(): Queue<BankTransferQueuePayload> {
  if (!queue) {
    connection = producerRedis(requireRedisUrl());
    queue = new Queue<BankTransferQueuePayload>(BANK_TRANSFER_QUEUE, {
      connection,
    });
  }
  return queue;
}

function errorCode(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const { code } = err;
    if (typeof code === "string") return code;
  }
  return "";
}

/**
 * Transient = the failure is about the infrastructure, not this row. Every row in
 * the batch would fail the same way, so the batch is abandoned and nothing burns an
 * attempt — otherwise a 20s Redis blip marks the whole backlog FAILED.
 */
export function isTransientPublishError(err: unknown): boolean {
  if (
    err instanceof Prisma.PrismaClientInitializationError ||
    err instanceof Prisma.PrismaClientUnknownRequestError
  ) {
    return true;
  }
  if (!(err instanceof Error)) return false;
  return (
    err.name === "MaxRetriesPerRequestError" ||
    /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EHOSTUNREACH)$/.test(
      errorCode(err),
    ) ||
    // "Command timed out" is what the producer connection's commandTimeout raises;
    // without it a Redis that accepts sockets but never answers reads as poison.
    /Connection is closed|Stream isn't writeable|Command timed out|LOADING|READONLY|CLUSTERDOWN|MASTERDOWN/i.test(
      err.message,
    )
  );
}

function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 5 ** (attempts - 1), BACKOFF_CAP_MS);
}

/**
 * Phase 1 — the claim. `SKIP LOCKED` is what makes N relays partition the backlog
 * instead of serializing on it or publishing the same row twice: the decision is the
 * database's, with no application coordination. `nextAttemptAt` keeps a row that is
 * backing off out of the batch entirely, so it cannot occupy a slot every tick.
 */
async function claimBatch(
  txn: Prisma.TransactionClient,
): Promise<OutboxClaim[]> {
  return txn.$queryRaw<OutboxClaim[]>`
    SELECT "id", "transactionId", "type", "amount", "userId", "attempts"
    FROM "TransactionOutbox"
    WHERE "publishStatus" = 'PENDING' AND "nextAttemptAt" <= now()
    ORDER BY "createdAt" ASC
    LIMIT ${BATCH_SIZE}
    FOR UPDATE SKIP LOCKED
  `;
}

/**
 * Phase 2 — Redis only, no SQL. The amount is stringified here rather than anywhere
 * later: JSON preserves the difference between "12.30" and 12.3, and only one of them
 * is still money on the other side.
 */
async function publishAll(
  publisher: OutboxPublisher,
  rows: OutboxClaim[],
): Promise<{ publishedIds: string[]; poisoned: PoisonedRow[] }> {
  const publishedIds: string[] = [];
  const poisoned: PoisonedRow[] = [];

  for (const row of rows) {
    const payload: BankTransferQueuePayload = {
      id: row.id,
      type: row.type,
      transactionId: row.transactionId,
      userId: row.userId,
      amount: String(row.amount),
    };
    try {
      await publisher.add(payload.type, payload, {
        jobId: payload.id,
        ...JOB_OPTIONS,
      });
      publishedIds.push(row.id);
    } catch (err: unknown) {
      // Transient failures belong to the batch, not the row: rethrowing abandons the
      // whole batch with nothing counted, so a Redis blip cannot poison the backlog.
      if (isTransientPublishError(err)) throw err;
      poisoned.push({ row, cause: err });
    }
  }

  return { publishedIds, poisoned };
}

/**
 * Phase 3 — SQL only, no Redis. Running after every publish is what removes the need
 * for savepoints: there is no half-finished row to unwind, because the fallible step
 * and the durable step never share a try block.
 */
async function recordOutcome(
  txn: Prisma.TransactionClient,
  publishedIds: string[],
  poisoned: PoisonedRow[],
): Promise<void> {
  if (publishedIds.length > 0) {
    await txn.transactionOutbox.updateMany({
      where: { id: { in: publishedIds } },
      data: { publishStatus: "PUBLISHED" },
    });
  }

  for (const { row, cause } of poisoned) {
    const attempts = row.attempts + 1;
    const exhausted = attempts >= MAX_PUBLISH_ATTEMPTS;
    await txn.transactionOutbox.update({
      where: { id: row.id },
      data: {
        attempts,
        publishStatus: exhausted ? "FAILED" : "PENDING",
        nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
      },
    });
    console.error(
      new AppError(
        exhausted ? "OUTBOX_ROW_DEAD_LETTERED" : "OUTBOX_ROW_PUBLISH_FAILED",
        `outbox row ${row.id} failed to publish (attempt ${attempts}/${MAX_PUBLISH_ATTEMPTS})`,
        500,
        cause,
      ),
    );
  }
}

/**
 * Claim, publish, record — publish-then-mark, in one transaction. A crash anywhere
 * after the publish and before the commit leaves the row PENDING and the job in
 * Redis: re-delivered next tick, absorbed by the consumer's dedup. The reverse
 * ordering would fail toward a row marked done that nobody ever received.
 *
 * Returns the number of rows CLAIMED (not published) — the drain loop reads it as
 * "the batch was full, there is probably more behind it".
 */
export async function publishBatch(
  publisher: OutboxPublisher = outboxQueue(),
): Promise<number> {
  return prisma.$transaction(
    async (txn) => {
      const rows = await claimBatch(txn);
      const { publishedIds, poisoned } = await publishAll(publisher, rows);
      await recordOutcome(txn, publishedIds, poisoned);
      return rows.length;
    },
    { timeout: TXN_TIMEOUT_MS },
  );
}

/**
 * Drains to empty, then returns. Re-entrant by design: a NOTIFY that lands mid-drain
 * sets `rerun` instead of starting a second overlapping drain, so a burst of commits
 * costs one extra sweep rather than one drain per notification.
 */
export async function drain(publisher?: OutboxPublisher): Promise<void> {
  if (draining) {
    rerun = true;
    return;
  }
  draining = true;
  try {
    do {
      rerun = false;
      let claimed: number;
      do {
        claimed = await publishBatch(publisher);
      } while (claimed === BATCH_SIZE);
    } while (rerun);
  } catch (err: unknown) {
    console.error(
      new AppError("RELAY_PUBLISH_FAILED", "outbox drain failed", 500, err),
    );
  } finally {
    draining = false;
  }
}

/**
 * (Re)opens the dedicated LISTEN connection. A pg Client is single-use — a second
 * connect() on the same instance throws — so each attempt builds a fresh one and
 * retires the old. Drains at the end because notifications fired while the channel
 * was down reached nobody and are gone; only a scan finds that backlog.
 */
async function listen(): Promise<void> {
  const retired = pgClient;
  if (retired) {
    retired.removeAllListeners("notification");
    retired.removeAllListeners("error");
    retired.on("error", () => {}); // a discarded socket must not raise an unhandled 'error'
    void retired.end().catch(() => {});
  }

  pgClient = new Client(process.env.DATABASE_URL);
  pgClient.on("notification", () => {
    void drain();
  });
  pgClient.on("error", (err: Error) => {
    console.error(
      new AppError("RELAY_LISTEN_LOST", "outbox LISTEN channel lost", 500, err),
    );
    scheduleReconnect();
  });

  await pgClient.connect();
  // Channel name must match the trigger migration's NOTIFY exactly, unquoted on both
  // sides (Postgres folds unquoted identifiers to lowercase).
  await pgClient.query("LISTEN outbox_notification");
  await drain(); // LISTEN first, then sweep — nothing falls in the gap
}

/**
 * Runs detached from any await, so it must never reject — an escaping rejection
 * would kill the process this exists to keep alive. Re-entry guarded because a
 * dying connection can emit 'error' more than once.
 */
function scheduleReconnect(): void {
  if (reconnecting || stopping) return;
  reconnecting = true;
  const delay = Math.min(1_000 * 2 ** listenAttempts++, 30_000);

  setTimeout(async () => {
    let reconnected = false;
    try {
      await listen();
      listenAttempts = 0;
      reconnected = true;
    } catch (err: unknown) {
      console.error(
        new AppError(
          "RELAY_LISTEN_RETRY_FAILED",
          "outbox LISTEN reconnect failed",
          500,
          err,
        ),
      );
    }
    reconnecting = false;
    if (!reconnected) scheduleReconnect();
  }, delay);
}

/**
 * Boot deliberately fails fast: a relay quietly retrying a mistyped DATABASE_URL
 * looks alive while delivering nothing. Reconnects only cover a channel that
 * worked at least once.
 */
export async function startRelay(): Promise<void> {
  stopping = false;
  await listen();
  fallbackPoll = setInterval(() => void drain(), FALLBACK_POLL_MS);
}

/** Safe to call twice, and safe to call on a relay that was never started. */
export async function stopRelay(): Promise<void> {
  stopping = true;
  clearInterval(fallbackPoll);
  fallbackPoll = undefined;

  const client = pgClient;
  const openQueue = queue;
  const openConnection = connection;
  pgClient = undefined;
  queue = undefined;
  connection = undefined;

  await client?.end();
  await openQueue?.close();
  // BullMQ leaves an externally supplied connection open, so the relay closes its own.
  await openConnection?.quit();
}
