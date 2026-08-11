import { randomUUID } from "node:crypto";
import { prisma, TransactionOutbox } from "@payments/db/client";
import type { BankTransferQueuePayload } from "@payments/types";
import { Job, Queue } from "bullmq";
import { Decimal } from "decimal.js";
import type { Redis } from "ioredis";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  createBankTransferConsumer,
  type BankTransferConsumer,
} from "../src/outbox/consumer.js";
import { BANK_TRANSFER_QUEUE, requireRedisUrl } from "../src/outbox/queue.js";
import {
  drain,
  publishBatch,
  startRelay,
  stopRelay,
  type OutboxPublisher,
} from "../src/outbox/relay.js";
import { producerRedis } from "../src/redis.js";
import { app, authHeader, registerUser, type RegisteredUser } from "./helpers.js";

// 19 significant digits: representable in Decimal(20,2), NOT representable as a JS
// number. Any float in the path — including a JSON.parse of an unquoted number —
// changes the value, so this amount is the one that can catch it.
const LOSSY_AS_FLOAT = "12345678901234567.89";

// A second queue handle, connected like any other client would be. Reading jobs back
// through Redis (rather than through the relay's own object) is what makes the payload
// assertions a real wire round-trip.
let inspector: Queue<BankTransferQueuePayload>;
let inspectorConnection: Redis;
let consumer: BankTransferConsumer | undefined;

beforeAll(() => {
  inspectorConnection = producerRedis(requireRedisUrl());
  inspector = new Queue<BankTransferQueuePayload>(BANK_TRANSFER_QUEUE, {
    connection: inspectorConnection,
  });
});

beforeEach(async () => {
  await inspector.obliterate({ force: true });
});

afterEach(async () => {
  await consumer?.close();
  consumer = undefined;
});

afterAll(async () => {
  await inspector.close();
  await inspectorConnection.quit();
  await stopRelay();
});

async function deposit(
  user: RegisteredUser,
  amount: string,
): Promise<request.Response> {
  return request(app)
    .post("/api/v1/wallet/banktransfer")
    .send({ direction: "deposit", amount })
    .set({
      authorization: authHeader(user.token).Authorization,
      IdempotencyKey: randomUUID(),
    })
    .expect(201);
}

async function theOutboxRow(): Promise<TransactionOutbox> {
  const rows = await prisma.transactionOutbox.findMany();
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function nextEvent(
  event: "completed" | "failed",
  timeoutMs = 10_000,
): Promise<Job<BankTransferQueuePayload>> {
  const worker = consumer!.worker;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no job ${event} within ${timeoutMs}ms`)),
      timeoutMs,
    );
    worker.once(event, (job?: Job<BankTransferQueuePayload>) => {
      clearTimeout(timer);
      resolve(job!);
    });
  });
}

/**
 * The state a relay leaves behind when it dies between `queue.add` and the mark: the
 * job is in Redis, the mark never committed. Reproduced by hand here because the two
 * writes are one transaction — the only way to sit between them is to not commit.
 */
async function rewindToUnpublished(id: string): Promise<void> {
  await prisma.transactionOutbox.update({
    where: { id },
    data: { publishStatus: "PENDING" },
  });
}

async function waitUntil(
  condition: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition still false after ${timeoutMs}ms`);
}

describe("transactional outbox", () => {
  describe("one write, not two", () => {
    it("commits the event intent in the same transaction as the money", async () => {
      const user = await registerUser();

      await deposit(user, "250.75");

      const transaction = await prisma.transaction.findFirstOrThrow();
      const row = await theOutboxRow();
      expect(row.transactionId).toBe(transaction.id);
      expect(row.publishStatus).toBe("PENDING");
      expect(row.amount.toString()).toBe("250.75");
      // Nothing was enqueued on the request path — the row IS the enqueue.
      expect(await inspector.getJobCountByTypes("waiting", "active")).toBe(0);
    });

    it("writes no event when the transaction rolls back", async () => {
      const user = await registerUser();

      await request(app)
        .post("/api/v1/wallet/banktransfer")
        .send({ direction: "withdrawal", amount: "50" })
        .set({
          authorization: authHeader(user.token).Authorization,
          IdempotencyKey: randomUUID(),
        })
        .expect(402);

      // The money never moved, so no event may claim it did. Both facts share one commit.
      expect(await prisma.transaction.count()).toBe(0);
      expect(await prisma.transactionOutbox.count()).toBe(0);
    });
  });

  describe("the crash window", () => {
    it("delivers an event whose producer died before anything reached the queue", async () => {
      const user = await registerUser();
      await deposit(user, "80.00");

      // This is the crash: the request committed and the process is gone. Redis was
      // never told, and Postgres is the only thing that remembers the event is owed.
      const row = await theOutboxRow();
      expect(await inspector.getJob(row.id)).toBeUndefined();

      await drain();

      const job = await inspector.getJob(row.id);
      expect(job?.data.transactionId).toBe(row.transactionId);
      expect(
        (await prisma.transactionOutbox.findUniqueOrThrow({
          where: { id: row.id },
        })).publishStatus,
      ).toBe("PUBLISHED");
    });

    it("re-publishes when the relay dies after publishing and before marking", async () => {
      const user = await registerUser();
      await deposit(user, "80.00");
      const row = await theOutboxRow();

      // Publishes for real, then fails the way a severed Redis connection does. The
      // mark is in the same transaction, so it rolls back with the failure — exactly
      // the state a `kill -9` one line later would have left.
      const diesAfterPublishing: OutboxPublisher = {
        add: async (name, data, opts) => {
          await inspector.add(name, data, opts);
          throw Object.assign(new Error("read ECONNRESET"), {
            code: "ECONNRESET",
          });
        },
      };
      await expect(publishBatch(diesAfterPublishing)).rejects.toThrow(
        /ECONNRESET/,
      );

      expect(await inspector.getJob(row.id)).toBeDefined();
      const afterCrash = await prisma.transactionOutbox.findUniqueOrThrow({
        where: { id: row.id },
      });
      // Still owed, and the infrastructure failure cost it no attempt — publish-then-mark
      // fails toward re-delivery, never toward a row marked done that nobody received.
      expect(afterCrash.publishStatus).toBe("PENDING");
      expect(afterCrash.attempts).toBe(0);

      await drain();

      expect(
        (await prisma.transactionOutbox.findUniqueOrThrow({
          where: { id: row.id },
        })).publishStatus,
      ).toBe("PUBLISHED");
    });
  });

  describe("more than one relay", () => {
    it("lets two relays drain one backlog without publishing a row twice", async () => {
      const user = await registerUser();
      for (let i = 0; i < 5; i++) await deposit(user, "10.00");
      const pending = await prisma.transactionOutbox.findMany();
      expect(pending).toHaveLength(5);

      const publishedBy: { relay: string; id: string }[] = [];
      const relay = (name: string): OutboxPublisher => ({
        add: async (jobName, data, opts) => {
          // Slow enough that the two claims genuinely overlap in time rather than
          // running one after the other and proving nothing.
          await new Promise((resolve) => setTimeout(resolve, 20));
          publishedBy.push({ relay: name, id: data.id });
          return inspector.add(jobName, data, opts);
        },
      });

      await Promise.all([publishBatch(relay("a")), publishBatch(relay("b"))]);

      // The claim is decided by the database, so a row belongs to exactly one relay.
      // Without it both would read the same PENDING rows and publish all five twice.
      expect(publishedBy.map(({ id }) => id).sort()).toEqual(
        pending.map(({ id }) => id).sort(),
      );
      expect(
        await prisma.transactionOutbox.count({
          where: { publishStatus: "PUBLISHED" },
        }),
      ).toBe(5);
    });
  });

  describe("the wake-up", () => {
    it("publishes on the commit's NOTIFY, without waiting for the poll", async () => {
      await startRelay();
      try {
        const user = await registerUser();
        await deposit(user, "15.00");

        // Nothing here calls drain(). The only paths from a committed row to Redis are
        // the trigger's NOTIFY and the 5s fallback poll, so a 2s budget passes on the
        // first and fails on the second — which is what makes this a NOTIFY test.
        await waitUntil(
          async () =>
            (await prisma.transactionOutbox.findFirst())?.publishStatus ===
            "PUBLISHED",
          2_000,
        );
      } finally {
        await stopRelay();
      }
    });
  });

  describe("an at-least-once pipe into an idempotent sink", () => {
    it("produces exactly one effect when the same event is published twice", async () => {
      const user = await registerUser();
      await deposit(user, "120.00");
      const row = await theOutboxRow();

      const effects: string[] = [];
      consumer = createBankTransferConsumer(async (payload) => {
        effects.push(payload.id);
      });

      const firstDelivery = nextEvent("completed");
      await drain();
      await firstDelivery;

      // BullMQ's jobId dedup only holds while the job exists; once removeOnComplete
      // evicts it the id is free and a re-publish is a genuinely new job. That is the
      // duplicate the DB layer has to absorb — so remove it and re-publish.
      await (await inspector.getJob(row.id))!.remove();
      await rewindToUnpublished(row.id);

      const secondDelivery = nextEvent("completed");
      await drain();
      const redelivered = await secondDelivery;

      expect(redelivered.id).toBe(row.id);
      expect(effects).toEqual([row.id]);
      expect(await prisma.idempotencyJobRecord.count()).toBe(1);
    });

    it("does not repeat an effect when a job is retried", async () => {
      const user = await registerUser();
      await deposit(user, "60.00");
      const row = await theOutboxRow();

      let invocations = 0;
      consumer = createBankTransferConsumer(async () => {
        invocations++;
        throw new Error("bank unreachable");
      });

      const failure = nextEvent("failed");
      const retry = nextEvent("completed", 15_000);
      await drain();
      await failure;
      await retry;

      // The retry is the SAME job re-run. It finds the claim already committed and
      // returns without acting — one delivery, one attempt at the effect, one record.
      expect(invocations).toBe(1);
      expect(await prisma.idempotencyJobRecord.count()).toBe(1);
      expect(
        await prisma.idempotencyJobRecord.findUnique({
          where: { eventId: row.id },
        }),
      ).not.toBeNull();
    });
  });

  describe("money on the wire", () => {
    it("carries the amount as a string no float could hold", async () => {
      const user = await registerUser();
      await deposit(user, LOSSY_AS_FLOAT);
      const row = await theOutboxRow();

      await drain();

      // Read back out of Redis: this value survived Postgres numeric -> JSON -> Redis.
      const job = await inspector.getJob(row.id);
      expect(typeof job?.data.amount).toBe("string");
      expect(job?.data.amount).toBe(LOSSY_AS_FLOAT);
      expect(new Decimal(job!.data.amount).equals(LOSSY_AS_FLOAT)).toBe(true);
      // The reason the quotes matter: the same value as a JS number is a different value.
      expect(String(Number(LOSSY_AS_FLOAT))).not.toBe(LOSSY_AS_FLOAT);
    });
  });
});
