import { prisma, type BankRequestStatus } from "@payments/db/client";
import { BankTransferQueuePayload } from "@payments/types";
import {
  BankResponse,
  bankResponseSchema,
  bankTransferQueuePayloadSchema,
} from "@payments/zod-schemas";
import { Job, UnrecoverableError, Worker } from "bullmq";
import { AppError } from "../errors/index.js";
import { validate } from "../middleware/validation.js";
import { consumerRedis } from "../redis.js";
import { BANK_TRANSFER_QUEUE, requireRedisUrl } from "./queue.js";
import { config } from "../config.js";
import axios, { AxiosError } from "axios";
import { getSignatureHeader } from "../bank/signature.js";

const BANK_REQUEST_TIMEOUT_MS = 5_000;
const secret = config.hmacE2BSecretKey;
/**
 * The bank's acknowledgement that it validated and durably recorded the instruction (ISO 20022
 * `ACTC`). It says nothing about the transfer's fate — every business outcome, rejection included,
 * arrives by callback, so the consumer never moves money (ADR-020).
 */
export type BankTransferEffect = (
  payload: BankTransferQueuePayload,
) => Promise<BankResponse>;

export interface BankTransferConsumer {
  worker: Worker<BankTransferQueuePayload>;
  close(): Promise<void>;
}

// Codes meaning "understood and refused". Retrying any of them sends identical bytes to an
// identical answer, so they stop the job instead of consuming the retry budget. Each refuses the
// request, never the transfer: an earlier attempt under the same reference may have landed.
const TERMINAL_BANK_CODES = new Set([
  "AUTHENTICATION_FAILED",
  "INVALID_REQUEST",
  "IDEMPOTENCY_KEY_REUSED",
]);

function bankErrorCode(error: AxiosError): string | undefined {
  const data: unknown = error.response?.data;
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const envelope = (data as { error?: { code?: unknown } }).error;
  return typeof envelope?.code === "string" ? envelope.code : undefined;
}

function isTerminal(error: AxiosError): boolean {
  const status = error.response?.status;
  // No response at all. The transfer may have been fully processed, partially processed, or never
  // seen — and retrying is safe here only because the bank dedups on the reference we send.
  if (status === undefined) {
    return false;
  }
  const code = bankErrorCode(error);
  // SIGNATURE_EXPIRED shares 401 with AUTHENTICATION_FAILED, but a fresh signature will pass.
  if (code === "SIGNATURE_EXPIRED") {
    return false;
  }
  if (code !== undefined) {
    return TERMINAL_BANK_CODES.has(code);
  }
  // An unclassifiable 4xx is still our bug: the same bytes will fail again. 429 is the carve-out,
  // and 5xx is a bank-side fault that may clear.
  return status >= 400 && status < 500 && status !== 429;
}

/** Stops the job for good: retrying cannot change the answer, so the reason must be visible. */
function deadLetter(reason: AppError): never {
  console.error(reason);
  throw new UnrecoverableError(reason.message);
}

const submitToBank: BankTransferEffect = async (payload) => {
  const bankInputs = {
    pspReferenceId: payload.transactionId,
    amount: payload.amount,
    currency: "INR",
  };
  const body = JSON.stringify(bankInputs);

  try {
    const { data } = await axios.post<unknown>(
      `${config.bankTransferHost}${config.bankTransferUrl}`,
      body,
      {
        headers: {
          "X-Signature": getSignatureHeader({
            secret,
            body,
            now: Math.floor(Date.now() / 1000),
            method: "POST",
            path: config.bankTransferUrl,
          }),
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(BANK_REQUEST_TIMEOUT_MS),
      },
    );
    const response = bankResponseSchema.safeParse(data);
    if (!response.success) {
      // The bank accepted the instruction; we cannot read its answer. Re-sending would replay the
      // same response, so this stops — and the request stands as in-doubt for reconciliation.
      deadLetter(
        new AppError(
          "BANK_RESPONSE_UNREADABLE",
          `bank accepted transfer ${payload.transactionId} but its response did not parse`,
          500,
          response.error,
        ),
      );
    }
    return response.data;
  } catch (error: unknown) {
    if (error instanceof AxiosError && isTerminal(error)) {
      // A refused request is not a refused transfer: an earlier attempt may have landed, so this
      // stops without an outcome and the request stays in doubt.
      deadLetter(
        new AppError(
          "BANK_REQUEST_REFUSED",
          `bank refused the request for transfer ${payload.transactionId} [${bankErrorCode(error) ?? error.response?.status}]`,
          500,
          error,
        ),
      );
    }
    throw error;
  }
};

/**
 * Records the attempt before the bank is contacted. Deliberately committed on its own rather than
 * wrapped around the call that follows: the row must be durable *before* the request goes out, so a
 * crash in between leaves an in-doubt row rather than no evidence that we ever called.
 *
 * Returns true when this delivery won the claim, false when a row already exists for the event.
 */
async function claimBankRequest(
  payload: BankTransferQueuePayload,
): Promise<boolean> {
  const { count } = await prisma.bankRequest.createMany({
    skipDuplicates: true,
    data: { eventId: payload.id, transactionId: payload.transactionId },
  });
  return count === 1;
}

async function markSubmitted(
  eventId: string,
  bankReference: string,
): Promise<void> {
  await prisma.bankRequest.update({
    data: { status: "SUBMITTED", bankReference, lastError: null },
    where: { eventId },
  });
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Records why an attempt failed. A failure the worker will retry leaves the row SUBMITTING; one it
 * will not — refused, unreadable, or out of attempts — marks it HALTED, so "stopped for good" is a
 * status rather than a fact only the queue's failed set holds. Neither resolves the outcome: a
 * HALTED request may still have landed at the bank, and is left for reconciliation.
 */
async function recordFailedAttempt(
  eventId: string,
  error: unknown,
  isFinalAttempt: boolean,
): Promise<void> {
  const halted = isFinalAttempt || error instanceof UnrecoverableError;
  await prisma.bankRequest.update({
    data: {
      lastError: reasonOf(error),
      ...(halted && { status: "HALTED" as const }),
    },
    where: { eventId },
  });
}

async function submit(
  payload: BankTransferQueuePayload,
  effect: BankTransferEffect,
  isFinalAttempt: boolean,
): Promise<void> {
  try {
    const { trackingId: bankReference } = await effect(payload);
    await markSubmitted(payload.id, bankReference);
  } catch (error: unknown) {
    await recordFailedAttempt(payload.id, error, isFinalAttempt);
    throw error;
  }
}

/**
 * The claim was skipped but no row can be read for this event. `skipDuplicates` suppresses *any*
 * unique violation, so this is the `transactionId` tripwire firing: one transaction produced two
 * outbox rows, which breaks the 1:1 the outbox relies on.
 *
 * Stopping is the only safe response. Assuming the transfer is done drops the payment; assuming it
 * is not may pay twice. Neither guess is available on this path.
 */
function refuseToGuess(eventId: string): never {
  deadLetter(
    new AppError(
      "BANK_REQUEST_MISSING",
      `claim for event ${eventId} was skipped but no request row can be read`,
      500,
    ),
  );
}

function parsePayload(
  job: Job<BankTransferQueuePayload>,
): BankTransferQueuePayload {
  try {
    return validate(bankTransferQueuePayloadSchema, job.data);
  } catch (err: unknown) {
    deadLetter(
      new AppError(
        "QUEUE_PAYLOAD_INVALID",
        `job ${job.id} carries an unusable payload`,
        500,
        err,
      ),
    );
  }
}

export async function processBankTransfer(
  job: Job<BankTransferQueuePayload>,
  effect: BankTransferEffect = submitToBank,
): Promise<void> {
  const payload = parsePayload(job);
  // BullMQ counts attempts already failed, so this run is the last when one more reaches the cap.
  const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  if (await claimBankRequest(payload)) {
    return await submit(payload, effect, isFinalAttempt);
  }

  const request = await prisma.bankRequest.findUnique({
    select: { status: true },
    where: { eventId: payload.id },
  });
  if (!request) {
    refuseToGuess(payload.id);
  }

  const status: BankRequestStatus = request.status;
  switch (status) {
    // In doubt: a previous attempt claimed and never recorded an outcome. Re-sending is safe by
    // construction — the bank dedups on the reference we send — and is the only way to learn what
    // happened without waiting for reconciliation. This is the case a boolean "seen" record could
    // not express, and where it dropped the payment silently instead.
    case "SUBMITTING":
      return await submit(payload, effect, isFinalAttempt);

    // Already answered. A redelivery must not reach the bank again.
    case "SUBMITTED":
      return;

    // Stopped deliberately and left for reconciliation. A redelivery must not quietly resume it;
    // re-driving a halted request is an operator action.
    case "HALTED":
      return;

    default: {
      const unhandled: never = status;
      throw new AppError(
        "BANK_REQUEST_STATUS_UNHANDLED",
        `bank request status ${String(unhandled)} has no handler`,
        500,
      );
    }
  }
}

/**
 * Backstop for a job that died without `submit` recording it — BullMQ fails a job that stalled past
 * its limit without calling the processor, leaving the row SUBMITTING behind a dead job. Guarded on
 * SUBMITTING so it never overwrites an answer or a HALTED that `submit` already wrote. Best-effort:
 * a crash before this runs leaves the row for the reconciliation sweep.
 */
async function haltAbandonedRequest(
  eventId: string,
  reason: string,
): Promise<void> {
  await prisma.bankRequest.updateMany({
    where: { eventId, status: "SUBMITTING" },
    data: { status: "HALTED", lastError: reason },
  });
}

// The relay publishes with the outbox row id as the job id, so it names the row without trusting
// job.data, which only the processor validates.
function haltIfDead(
  eventId: string | undefined,
  err: Error,
  dead: boolean,
): void {
  if (!eventId || !dead) {
    return;
  }
  haltAbandonedRequest(eventId, err.message).catch((haltErr: unknown) => {
    console.error(
      new AppError(
        "BANK_REQUEST_HALT_FAILED",
        `job ${eventId} is dead but its request could not be marked HALTED`,
        500,
        haltErr,
      ),
    );
  });
}

function announceOutcomes(worker: Worker<BankTransferQueuePayload>): void {
  worker.on("failed", (job, err) => {
    const exhausted = !job || job.attemptsMade >= (job.opts.attempts ?? 1);
    haltIfDead(job?.id, err, exhausted || err instanceof UnrecoverableError);
    if (err instanceof UnrecoverableError) {
      console.error(
        new AppError(
          "WORKER_JOB_DEAD_LETTERED",
          `job ${job?.id} is dead lettered due to  ${err.message}`,
          500,
          err,
        ),
      );
    } else {
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
    }
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
