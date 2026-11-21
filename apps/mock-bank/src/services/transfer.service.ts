import {
  Prisma,
  prisma,
  type DeliveryStatus,
  type Status,
  type TransactionEvent,
  type TransferRequest,
} from "../../lib/prisma.js";
import { AppError, ConflictError, NotFoundError } from "../errors/index.js";
import type { TransferInputs } from "../zod/index.js";
import axios, { AxiosError } from "axios";
import { getSignatureHeader } from "./authenticate.js";
import { config } from "../config.js";

export const BATCH_SIZE = 20;
const MAX_DELIVERY_ATTEMPTS = 6;
const LEASED_SECONDS = 130;
const RESCHEDULE_AFTER = [10_000, 60_000, 300_000, 1_800_000, 7_200_000];
const TERMINAL_ERROR_CODES = new Set([
  "AUTHENTICATION_FAILED",
  "INVALID_REQUEST",
  "IDEMPOTENCY_KEY_REUSED",
]);

function backoffMs(attempts: number): number {
  return RESCHEDULE_AFTER[attempts - 1] ?? 0;
}
type Event = Pick<
  TransactionEvent,
  "trackingId" | "pspReferenceId" | "amount" | "currency" | "receivedAt"
>;

type QueryResponse = Omit<
  TransactionEvent,
  | "eventId"
  | "deliveryStatus"
  | "attempts"
  | "nextAttempt"
  | "lastError"
  | "settledAt"
> & { settledAt: Date | null };

export async function logTransferRequest(
  data: TransferInputs,
): Promise<TransferRequest> {
  const { pspReferenceId, amount, currency } = data;
  return await prisma.$transaction(async (txn) => {
    const [result] = await txn.transferRequest.createManyAndReturn({
      skipDuplicates: true,
      data: {
        amount,
        pspReferenceId,
        currency,
      },
    });
    if (!result) {
      const [record] = await txn.transferRequest.findMany({
        where: {
          pspReferenceId,
          amount,
          currency,
        },
      });
      if (!record) {
        throw new ConflictError(
          "IDEMPOTENCY_KEY_REUSED",
          "key reused for a different request",
          422,
        );
      }
      return record;
    }
    return result;
  });
}

async function lockAndFetchTransfers(
  txn: Prisma.TransactionClient,
): Promise<TransferRequest[]> {
  return await txn.$queryRaw<TransferRequest[]>`
    SELECT * FROM "TransferRequest" 
    WHERE "status"= 'RECEIVED' 
    LIMIT ${BATCH_SIZE} 
    FOR UPDATE SKIP LOCKED
  `;
}

async function updateTransferRequest(
  txn: Prisma.TransactionClient,
  trackingId: string,
  status: Status,
) {
  await txn.transferRequest.update({
    where: {
      id: trackingId,
    },
    data: {
      status: status,
    },
  });
}

async function createEvent(
  txn: Prisma.TransactionClient,
  data: Event,
  status: Status,
): Promise<TransactionEvent> {
  const event = await txn.transactionEvent.create({
    data: {
      status,
      ...data,
    },
  });
  await updateTransferRequest(txn, event.trackingId, event.status);
  return event;
}

async function notify(secret: string, now: number, body: string) {
  await axios.post(`${config.webhookHost}${config.webhookUrl}`, body, {
    headers: {
      "X-Signature": getSignatureHeader({
        secret,
        payload: body,
        now,
        method: "POST",
        path: config.webhookUrl,
      }),
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(5000),
  });
}

function buildBody(event: TransactionEvent): string {
  const { deliveryStatus, attempts, nextAttempt, lastError, ...payload } =
    event;
  const body = JSON.stringify(payload);
  return body;
}

async function updateDeliveryStatus(
  eventId: string,
  deliveryStatus: DeliveryStatus,
  lastError?: string,
) {
  await prisma.transactionEvent.updateMany({
    where: {
      eventId,
      deliveryStatus: "PENDING",
    },
    data: {
      deliveryStatus,
      attempts: { increment: 1 },
      lastError: lastError || null,
    },
  });
}

function bankErrorCode(error: AxiosError): string | undefined {
  const data: unknown = error.response?.data;
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const envelope = (data as { error?: { code?: unknown } }).error;
  return typeof envelope?.code === "string" ? envelope.code : undefined;
}

function isTerminal(error: unknown): boolean {
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    if (status === undefined) {
      return false;
    }
    const code = bankErrorCode(error);
    if (code === "SIGNATURE_EXPIRED") {
      return false;
    }
    if (code !== undefined) {
      return TERMINAL_ERROR_CODES.has(code);
    }
    return status >= 400 && status < 500 && status !== 429;
  }
  return false;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function setRetry(eventId: string, attempts: number, err: unknown) {
  await prisma.transactionEvent.updateMany({
    where: {
      eventId,
      deliveryStatus: "PENDING",
    },
    data: {
      attempts,
      nextAttempt: new Date(Date.now() + backoffMs(attempts)),
      lastError: reasonOf(err),
    },
  });
}

export async function callback(): Promise<boolean> {
  const events = await prisma.$queryRaw<TransactionEvent[]>`
  UPDATE "TransactionEvent" 
  SET "nextAttempt" = now() + ${LEASED_SECONDS}::int * INTERVAL '1 second' 
  WHERE "eventId" IN (
    SELECT "eventId" FROM "TransactionEvent"
    WHERE "deliveryStatus" = 'PENDING' AND "nextAttempt" <= now()
    ORDER BY "nextAttempt"
    LIMIT ${BATCH_SIZE}
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *`;

  for (const event of events) {
    const now = Math.floor(Date.now() / 1000);
    const secret = config.bankToEngineSecret;
    const body = buildBody(event);
    const attempts = event.attempts + 1;
    try {
      await notify(secret, now, body);
      await updateDeliveryStatus(event.eventId, "DELIVERED");
    } catch (err) {
      const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;
      if (exhausted) {
        await updateDeliveryStatus(event.eventId, "EXHAUSTED", reasonOf(err));
      } else if (isTerminal(err)) {
        await updateDeliveryStatus(
          event.eventId,
          "UNDELIVERABLE",
          reasonOf(err),
        );
      } else {
        await setRetry(event.eventId, attempts, err);
      }
    }
  }
  return events.length === BATCH_SIZE;
}

export async function processTransfer(): Promise<boolean> {
  const count: number = await prisma.$transaction(async (txn) => {
    const requests = await lockAndFetchTransfers(txn);
    for (const request of requests) {
      const { id, amount, pspReferenceId, createdAt, currency } = request;
      const data = {
        trackingId: id,
        pspReferenceId,
        amount,
        currency,
        receivedAt: createdAt,
      };
      await createEvent(txn, data, "SETTLED");
    }
    return requests.length;
  });
  return count === BATCH_SIZE;
}

function buildTransferQueryResponse(
  transfer: TransferRequest,
  event: TransactionEvent | null,
): QueryResponse {
  return {
    trackingId: transfer.id,
    pspReferenceId: transfer.pspReferenceId,
    amount: transfer.amount,
    type: event?.type ?? "TRANSFER",
    status: transfer.status,
    currency: transfer.currency,
    rejectionReason: event?.rejectionReason ?? null,
    originalTrackingId: event?.originalTrackingId ?? null,
    receivedAt: transfer.createdAt,
    settledAt: event?.settledAt ?? null,
  };
}

export async function getTransaction(
  pspReferenceId: string,
): Promise<QueryResponse> {
  const transfer = await prisma.transferRequest.findUnique({
    where: { pspReferenceId },
  });
  if (!transfer) {
    throw new NotFoundError(
      "TRANSFER_NOT_FOUND",
      `Transaction with Id : ${pspReferenceId} is not found`,
    );
  }
  if (transfer.status !== "RECEIVED") {
    const event = await prisma.transactionEvent.findUnique({
      where: {
        trackingId_status: {
          trackingId: transfer.id,
          status: transfer.status,
        },
      },
    });
    if (!event) {
      throw new AppError(
        "TRANSFER_STATE_INCONSISTENT",
        `Transaction event with Id : ${pspReferenceId} is not found`,
        500,
      );
    }
    return buildTransferQueryResponse(transfer, event);
  }

  const transaction = buildTransferQueryResponse(transfer, null);

  return transaction;
}
