import { prisma } from "@payments/db/client";
import { BankTransferQueuePayload } from "@payments/types";
import { bankTransferQueuePayloadSchema } from "@payments/zod-schemas";
import { Job, UnrecoverableError, Worker } from "bullmq";
import { AppError } from "../errors/index.js";
import { validate } from "../middleware/validation.js";
import { consumerRedis } from "../redis.js";
import { BANK_TRANSFER_QUEUE, requireRedisUrl } from "./queue.js";

export type BankTransferEffect = (
  payload: BankTransferQueuePayload,
) => Promise<void>;

export interface BankTransferConsumer {
  worker: Worker<BankTransferQueuePayload>;
  close(): Promise<void>;
}

const logEffect: BankTransferEffect = async (payload) => {
  console.log(
    `bank transfer requested: ${payload.type} ${payload.amount} (event ${payload.id})`,
  );
};

function parsePayload(
  job: Job<BankTransferQueuePayload>,
): BankTransferQueuePayload {
  try {
    return validate(bankTransferQueuePayloadSchema, job.data);
  } catch (err: unknown) {
    const invalid = new AppError(
      "QUEUE_PAYLOAD_INVALID",
      `job ${job.id} carries an unusable payload`,
      500,
      err,
    );
    console.error(invalid);
    throw new UnrecoverableError(invalid.message);
  }
}

export async function processBankTransfer(
  job: Job<BankTransferQueuePayload>,
  effect: BankTransferEffect = logEffect,
): Promise<void> {
  const payload = parsePayload(job);

  const { count } = await prisma.idempotencyJobRecord.createMany({
    skipDuplicates: true,
    data: { eventId: payload.id },
  });
  if (!count) return;

  await effect(payload);
}

function announceOutcomes(worker: Worker<BankTransferQueuePayload>): void {
  worker.on("failed", (job, err) => {
    const exhausted = !job || job.attemptsMade >= (job.opts.attempts ?? 1);
    console.error(
      new AppError(
        exhausted ? "WORKER_JOB_DEAD_LETTERED" : "WORKER_JOB_ATTEMPT_FAILED",
        exhausted
          ? `job ${job?.id} exhausted its attempts and is in the failed set`
          : `job ${job.id} failed attempt ${job.attemptsMade}, retrying`,
        500,
        err,
      ),
    );
  });

  worker.on("error", (err) => {
    console.error(new AppError("WORKER_ERROR", "worker error", 500, err));
  });
}

export function createBankTransferConsumer(
  effect?: BankTransferEffect,
): BankTransferConsumer {
  const connection = consumerRedis(requireRedisUrl());
  const worker = new Worker<BankTransferQueuePayload>(
    BANK_TRANSFER_QUEUE,
    (job) => processBankTransfer(job, effect),
    { connection },
  );
  announceOutcomes(worker);

  return {
    worker,
    close: async (): Promise<void> => {
      await worker.close();
      await connection.quit();
    },
  };
}
