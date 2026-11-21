import {
  DisputeReason,
  FailureReason,
  Prisma,
  prisma,
  ReconciliationEventType,
  ReconciliationRecord,
  Transaction,
  TransactionStatus,
} from "@payments/db/client";
import { Decimal } from "decimal.js";
import { BankTransferWebhookCallbackInputs } from "@payments/zod-schemas";
import { IdempotencyError } from "../errors/index.js";
import crypto from "node:crypto";
import { lockAndFetchTransaction, postSettlement } from "./wallet.service.js";

type ReconciliationRecordData = Omit<
  ReconciliationRecord,
  "id" | "createdAt" | "updatedAt"
>;

/** The bank's words restated in the engine's own vocabulary */
type CanonicalEvent = {
  status: TransactionStatus;
  type: ReconciliationEventType;
  failureReason: FailureReason | null;
};

type TransactionMatch =
  | { matched: true; transaction: Transaction }
  | { matched: false; disputeReason: DisputeReason };

/**
 * Every value here is an outcome the engine has *recorded*, which is why nothing below throws
 * to express one: a throw rolls back the dedup claim with it, and a rejection that is not
 * durable is not a rejection — the bank retries and gets a different answer. The HTTP
 * status therefore reports durability, not agreement, and a dispute lives in the
 * reconciliation record where a sweep and a human can both read it.
 */
export type SettlementOutcome =
  | "APPLIED"
  | "ACKNOWLEDGED"
  | "ALREADY_RESOLVED"
  | "DUPLICATE"
  | "DISPUTED";

type Transition = {
  outcome: SettlementOutcome;
  disputeReason: DisputeReason | null;
  // The terminal state to drive the held money to, or null when this callback moves nothing.
  post: Extract<TransactionStatus, "SUCCESS" | "FAILED"> | null;
};

const ACKNOWLEDGED: Transition = {
  outcome: "ACKNOWLEDGED",
  disputeReason: null,
  post: null,
};

function hashPayload(data: BankTransferWebhookCallbackInputs): string {
  return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

/** Returns true when this delivery is new, false when it is a redelivery of one already handled. */
async function claimEvent(
  txn: Prisma.TransactionClient,
  data: {
    eventId: string;
    requestHash: string;
    payload: BankTransferWebhookCallbackInputs;
  },
): Promise<boolean> {
  const { eventId, requestHash, payload } = data;

  const { count } = await txn.webhookEvent.createMany({
    skipDuplicates: true,
    data: { eventId, requestHash, payload },
  });
  if (count) {
    return true;
  }

  const event = await txn.webhookEvent.findUnique({
    where: { eventId, requestHash },
    select: { eventId: true },
  });

  if (!event) {
    throw new IdempotencyError(`Idempotency key ${eventId} reused`);
  }
  return false;
}

function toCanonicalStatus(
  status: BankTransferWebhookCallbackInputs["status"],
): TransactionStatus {
  switch (status) {
    case "SETTLED":
      return "SUCCESS";
    case "REJECTED":
      return "FAILED";
    case "RECEIVED":
      return "PENDING";
  }
}

function toCanonicalType(
  type: BankTransferWebhookCallbackInputs["type"],
): ReconciliationEventType {
  switch (type) {
    case "TRANSFER":
      return "SETTLEMENT";
    case "RETURN":
      return "RETURN";
  }
}

// Exhaustive switches, no fallback branch: a status or type the provider adds has to be mapped
// deliberately and fails the build until it is, rather than falling into whichever case is last.
function toCanonical(data: BankTransferWebhookCallbackInputs): CanonicalEvent {
  return {
    status: toCanonicalStatus(data.status),
    type: toCanonicalType(data.type),
    failureReason: data.status === "REJECTED" ? data.rejectionReason : null,
  };
}

async function matchTransaction(
  txn: Prisma.TransactionClient,
  data: { transactionId: string; amount: Decimal },
): Promise<TransactionMatch> {
  const transaction = await lockAndFetchTransaction(txn, data.transactionId);
  if (!transaction) {
    return { matched: false, disputeReason: "UNKNOWN_REFERENCE" };
  }

  if (!transaction.amount.equals(data.amount)) {
    return { matched: false, disputeReason: "AMOUNT_MISMATCH" };
  }
  return { matched: true, transaction };
}

/**
 * The dedup claim answers "have I seen this message?". This answers "is this transition legal
 * from where the transfer actually is?". They are different questions, and a callback arriving
 * twice, early, or late needs both of them answered.
 */
function classifyTransition(
  current: TransactionStatus,
  canonical: CanonicalEvent,
): Transition {
  // A RETURN is the bank clawing back a transfer, not an answer to the one being waited on.
  // Unwinding it is its own flow and is not built, so it is recorded and acknowledged and the
  // row is left for the sweep to pick up — never quietly applied as if it were a settlement.
  if (canonical.type === "RETURN" || canonical.status === "PENDING") {
    return ACKNOWLEDGED;
  }
  if (current === "PENDING") {
    return {
      outcome: "APPLIED",
      disputeReason: null,
      post: canonical.status,
    };
  }
  // Already terminal. Agreement is the same answer under a fresh event id — acknowledge and
  // ignore. Disagreement is the bank contradicting a settled fact, which a human has to own.
  if (current === canonical.status) {
    return { outcome: "ALREADY_RESOLVED", disputeReason: null, post: null };
  }
  return {
    outcome: "DISPUTED",
    disputeReason: "STATE_MISMATCH",
    post: null,
  };
}

function buildReconciliation(
  data: BankTransferWebhookCallbackInputs,
  canonical: CanonicalEvent,
  disputeReason: DisputeReason | null,
): ReconciliationRecordData {
  return {
    providerEventId: data.eventId,
    providerReferenceId: data.trackingId,
    originalReferenceId: data.originalTrackingId,
    transactionId: data.pspReferenceId,
    amount: new Decimal(data.amount),
    currency: data.currency,
    status: canonical.status,
    rawStatus: data.status,
    type: canonical.type,
    rawType: data.type,
    failureReason: canonical.failureReason,
    rawFailureReason: data.rejectionReason,
    providerReceivedAt: new Date(data.receivedAt),
    providerSettledAt: new Date(data.settledAt),
    reconciliationStatus: disputeReason ? "DISPUTED" : "PENDING",
    disputeReason,
  };
}

async function recordReconciliation(
  txn: Prisma.TransactionClient,
  data: ReconciliationRecordData,
): Promise<void> {
  // One row per bank transfer record rather than per delivery: providerReferenceId is stable for
  // the life of a transfer and the bank emits several events against it, so this row is the
  // current matching state while WebhookEvent.payload stays the append-only evidence.
  const { count } = await txn.reconciliationRecord.createMany({
    skipDuplicates: true,
    data,
  });
  if (count) {
    return;
  }
  // A dispute flags the record and keeps the status the ledger agreed with; the contradicting
  // claim is already evidence in WebhookEvent.payload.
  if (data.disputeReason) {
    await txn.reconciliationRecord.updateMany({
      where: {
        providerReferenceId: data.providerReferenceId,
        reconciliationStatus: "PENDING",
      },
      data: {
        reconciliationStatus: "DISPUTED",
        disputeReason: data.disputeReason,
        providerEventId: data.providerEventId,
      },
    });
    return;
  }
  // Late deliveries are ordinary — a RECEIVED can land after a SETTLED — so only a record still
  // waiting on an outcome advances, and a final one is never walked backwards. The guard is in
  // the where-clause rather than a read-then-write another delivery could interleave with.
  await txn.reconciliationRecord.updateMany({
    where: {
      providerReferenceId: data.providerReferenceId,
      reconciliationStatus: "PENDING",
      status: "PENDING",
    },
    data,
  });
}

export async function settleBankTransfer(
  data: BankTransferWebhookCallbackInputs,
): Promise<SettlementOutcome> {
  const amount = new Decimal(data.amount);
  const requestHash = hashPayload(data);
  const canonical = toCanonical(data);

  return await prisma.$transaction(async (txn) => {
    const claimed = await claimEvent(txn, {
      eventId: data.eventId,
      requestHash,
      payload: data,
    });
    if (!claimed) {
      return "DUPLICATE";
    }

    const match = await matchTransaction(txn, {
      transactionId: data.pspReferenceId,
      amount,
    });
    const transition: Transition = match.matched
      ? classifyTransition(match.transaction.status, canonical)
      : {
          outcome: "DISPUTED",
          disputeReason: match.disputeReason,
          post: null,
        };

    // Written on every path, agreed or disputed, and before anything posts — this is the
    // dispute's home, and what lets a refusal be durable without a status code carrying it.
    await recordReconciliation(
      txn,
      buildReconciliation(data, canonical, transition.disputeReason),
    );

    if (match.matched && transition.post) {
      await postSettlement(txn, match.transaction, transition.post);
    }

    await txn.webhookEvent.update({
      where: { eventId: data.eventId },
      data: { response: transition.outcome },
    });

    return transition.outcome;
  });
}
