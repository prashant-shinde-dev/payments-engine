import { createHmac, randomUUID } from "node:crypto";
import {
  CLEARING_ACC_WALLET_ID,
  HOUSE_WALLET_ID,
  prisma,
  Transaction,
} from "@payments/db/client";
import type { BankTransferWebhookCallbackInputs } from "@payments/zod-schemas";
import { Decimal } from "decimal.js";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  app,
  authHeader,
  deriveBalance,
  fundWallet,
  registerUser,
  type RegisteredUser,
} from "./helpers.js";

const WEBHOOK = "/api/v1/webhook/payment";

type Callback = BankTransferWebhookCallbackInputs;

// Signed here from the contract (section 2.2), not through the engine's own signer: a bug the
// signer and verifier shared would otherwise pass.
function signature(
  body: string,
  options: { secret?: string; t?: number; method?: string; path?: string } = {},
): string {
  const t = options.t ?? Math.floor(Date.now() / 1000);
  const secret = options.secret ?? process.env.BANK_TO_ENGINE_SECRET!;
  const v1 = createHmac("sha256", secret)
    .update(`${t}.${options.method ?? "POST"}${options.path ?? WEBHOOK}.${body}`)
    .digest("hex");
  return `t=${t},v1=${v1}`;
}

function deliver(body: string, header: string | null = signature(body)): request.Test {
  const req = request(app).post(WEBHOOK).set("Content-Type", "application/json");
  return (header === null ? req : req.set("X-Signature", header)).send(body);
}

function callbackFor(transaction: Transaction, overrides: Partial<Callback> = {}): Callback {
  const now = new Date().toISOString();
  return {
    eventId: randomUUID(),
    trackingId: randomUUID(),
    pspReferenceId: transaction.id,
    amount: new Decimal(transaction.amount.toString()).toFixed(2),
    status: "SETTLED",
    currency: "INR",
    type: "TRANSFER",
    rejectionReason: null,
    originalTrackingId: null,
    receivedAt: now,
    settledAt: now,
    ...overrides,
  };
}

async function pendingTransfer(
  user: RegisteredUser,
  direction: "deposit" | "withdrawal",
  amount: string,
): Promise<Transaction> {
  await request(app)
    .post("/api/v1/wallet/banktransfer")
    .send({ direction, amount })
    .set({
      authorization: authHeader(user.token).Authorization,
      IdempotencyKey: randomUUID(),
    })
    .expect(201);
  return prisma.transaction.findFirstOrThrow({
    where: {
      type: direction === "deposit" ? "BANK_DEPOSIT" : "BANK_WITHDRAWAL",
      OR: [{ fromUserId: user.user.id }, { toUserId: user.user.id }],
    },
  });
}

async function balanceOf(userId: string): Promise<string> {
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
  return new Decimal(wallet.balance.toString()).toFixed(2);
}

async function clearingBalance(): Promise<string> {
  const wallet = await prisma.wallet.findUniqueOrThrow({
    where: { id: CLEARING_ACC_WALLET_ID },
  });
  return new Decimal(wallet.balance.toString()).toFixed(2);
}

async function statusOf(transactionId: string): Promise<string> {
  const { status } = await prisma.transaction.findUniqueOrThrow({
    where: { id: transactionId },
  });
  return status;
}

function legsOf(transactionId: string) {
  return prisma.ledgerEntry.findMany({
    where: { transactionId },
    orderBy: { createdAt: "asc" },
  });
}

async function expectProjectionsMatchLedger(walletIds: string[]): Promise<void> {
  for (const walletId of walletIds) {
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
    expect((await deriveBalance(walletId)).toFixed(2)).toBe(
      new Decimal(wallet.balance.toString()).toFixed(2),
    );
  }
}

describe("bank webhook", () => {
  describe("authentication", () => {
    it("rejects a callback signed with the wrong secret and records nothing", async () => {
      const user = await registerUser();
      const transaction = await pendingTransfer(user, "deposit", "100.00");
      const body = JSON.stringify(callbackFor(transaction));

      const res = await deliver(body, signature(body, { secret: "not-the-bank" })).expect(401);

      expect(res.body.error.code).toBe("AUTHENTICATION_FAILED");
      expect(await prisma.webhookEvent.count()).toBe(0);
      expect(await statusOf(transaction.id)).toBe("PENDING");
    });

    it("rejects a callback signed more than five minutes ago as expired", async () => {
      const user = await registerUser();
      const transaction = await pendingTransfer(user, "deposit", "100.00");
      const body = JSON.stringify(callbackFor(transaction));
      const stale = Math.floor(Date.now() / 1000) - 301;

      const res = await deliver(body, signature(body, { t: stale })).expect(401);

      // Distinct from AUTHENTICATION_FAILED because it is the one refusal a re-signed
      // redelivery can pass.
      expect(res.body.error.code).toBe("SIGNATURE_EXPIRED");
      expect(await statusOf(transaction.id)).toBe("PENDING");
    });

    it("rejects a body changed after it was signed", async () => {
      const user = await registerUser();
      const transaction = await pendingTransfer(user, "deposit", "100.00");
      const signed = JSON.stringify(callbackFor(transaction));
      const tampered = signed.replace('"status":"SETTLED"', '"status":"REJECTED"');

      await deliver(tampered, signature(signed)).expect(401);

      expect(await prisma.webhookEvent.count()).toBe(0);
    });

    it("rejects a signature issued for another path", async () => {
      const user = await registerUser();
      const transaction = await pendingTransfer(user, "deposit", "100.00");
      const body = JSON.stringify(callbackFor(transaction));

      await deliver(body, signature(body, { path: "/api/v1/transfer" })).expect(401);

      expect(await prisma.webhookEvent.count()).toBe(0);
    });

    it("rejects a callback with no signature", async () => {
      const user = await registerUser();
      const transaction = await pendingTransfer(user, "deposit", "100.00");

      await deliver(JSON.stringify(callbackFor(transaction)), null).expect(401);

      expect(await prisma.webhookEvent.count()).toBe(0);
    });
  });

  describe("settlement", () => {
    it("settles a deposit by moving the hold out of clearing to the customer", async () => {
      const user = await registerUser();
      const transaction = await pendingTransfer(user, "deposit", "100.00");
      expect(await clearingBalance()).toBe("100.00");

      await deliver(JSON.stringify(callbackFor(transaction))).expect(200);

      expect(await statusOf(transaction.id)).toBe("SUCCESS");
      expect(await balanceOf(user.user.id)).toBe("100.00");
      expect(await clearingBalance()).toBe("0.00");
      const { id: walletId } = await prisma.wallet.findUniqueOrThrow({
        where: { userId: user.user.id },
      });
      await expectProjectionsMatchLedger([walletId, CLEARING_ACC_WALLET_ID, HOUSE_WALLET_ID]);
    });

    it("releases a rejected withdrawal back to the customer on the same transaction", async () => {
      const user = await registerUser();
      await fundWallet(user.user.id, "100.00");
      const transaction = await pendingTransfer(user, "withdrawal", "40.00");
      expect(await balanceOf(user.user.id)).toBe("60.00");
      const holdLegs = await legsOf(transaction.id);

      await deliver(
        JSON.stringify(
          callbackFor(transaction, {
            status: "REJECTED",
            rejectionReason: "INSUFFICIENT_FUNDS",
          }),
        ),
      ).expect(200);

      expect(await statusOf(transaction.id)).toBe("FAILED");
      expect(await balanceOf(user.user.id)).toBe("100.00");
      expect(await clearingBalance()).toBe("0.00");

      // Compensation is a second pair of legs on the same transaction: the hold is untouched
      // and the four legs net to zero — what "it did not happen" looks like in double entry.
      const legs = await legsOf(transaction.id);
      expect(legs).toHaveLength(4);
      expect(legs.slice(0, 2)).toEqual(holdLegs);
      const net = legs.reduce((sum, leg) => sum.plus(leg.amount.toString()), new Decimal(0));
      expect(net.toFixed(2)).toBe("0.00");

      // One failed withdrawal is one row in the customer's history, not a withdrawal and a
      // reversal.
      const { body } = await request(app)
        .get("/api/v1/wallet/transactions")
        .set(authHeader(user.token))
        .expect(200);
      const withdrawals = (body.data.transactions as { type: string; status: string }[]).filter(
        (row) => row.type === "BANK_WITHDRAWAL",
      );
      expect(withdrawals).toEqual([expect.objectContaining({ status: "FAILED" })]);
    });
  });

  describe("redelivery and ordering", () => {
    it("applies a redelivered callback once, without processing it again", async () => {
      const user = await registerUser();
      const transaction = await pendingTransfer(user, "deposit", "100.00");
      const callback = callbackFor(transaction);
      const body = JSON.stringify(callback);

      await deliver(body).expect(200);
      await deliver(body).expect(200);

      expect(await legsOf(transaction.id)).toHaveLength(4);
      expect(await balanceOf(user.user.id)).toBe("100.00");
      // The transition guard alone would also stop a second posting; what dedup adds is that
      // the redelivery never reaches it, so the first delivery's record is not rewritten.
      expect(
        await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: callback.eventId } }),
      ).toMatchObject({ response: "APPLIED" });
    });

    it("refuses an event id reused for a different payload", async () => {
      const user = await registerUser();
      const transaction = await pendingTransfer(user, "deposit", "100.00");
      const first = callbackFor(transaction);

      await deliver(JSON.stringify(first)).expect(200);
      const res = await deliver(
        JSON.stringify({ ...first, settledAt: new Date(Date.now() + 1_000).toISOString() }),
      ).expect(422);

      expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(await legsOf(transaction.id)).toHaveLength(4);
    });

    it("acknowledges a stale RECEIVED callback after settlement without effect", async () => {
      const user = await registerUser();
      const transaction = await pendingTransfer(user, "deposit", "100.00");
      const settled = callbackFor(transaction);

      await deliver(JSON.stringify(settled)).expect(200);
      await deliver(
        JSON.stringify({ ...settled, eventId: randomUUID(), status: "RECEIVED" }),
      ).expect(200);

      expect(await statusOf(transaction.id)).toBe("SUCCESS");
      expect(await legsOf(transaction.id)).toHaveLength(4);
      expect(await balanceOf(user.user.id)).toBe("100.00");
      // The reconciliation record is the matching state a sweep reads; a late event must not
      // walk it back from the settlement it already recorded.
      expect(
        await prisma.reconciliationRecord.findUniqueOrThrow({
          where: { providerReferenceId: settled.trackingId },
        }),
      ).toMatchObject({ status: "SUCCESS", rawStatus: "SETTLED" });
    });

    it("reaches the same final state when RECEIVED arrives after SETTLED or before it", async () => {
      const inOrder = await registerUser();
      const outOfOrder = await registerUser();
      const first = await pendingTransfer(inOrder, "deposit", "100.00");
      const second = await pendingTransfer(outOfOrder, "deposit", "100.00");

      const received = (t: Transaction) => callbackFor(t, { status: "RECEIVED" });
      await deliver(JSON.stringify(received(first))).expect(200);
      await deliver(JSON.stringify(callbackFor(first))).expect(200);
      await deliver(JSON.stringify(callbackFor(second))).expect(200);
      await deliver(JSON.stringify(received(second))).expect(200);

      for (const [user, transaction] of [
        [inOrder, first],
        [outOfOrder, second],
      ] as const) {
        expect(await statusOf(transaction.id)).toBe("SUCCESS");
        expect(await balanceOf(user.user.id)).toBe("100.00");
      }
    });

    it("records a callback that contradicts a final state as a dispute", async () => {
      const user = await registerUser();
      const transaction = await pendingTransfer(user, "deposit", "100.00");
      const settled = callbackFor(transaction);

      await deliver(JSON.stringify(settled)).expect(200);
      await deliver(
        JSON.stringify({
          ...settled,
          eventId: randomUUID(),
          status: "REJECTED",
          rejectionReason: "ACCOUNT_CLOSED",
        }),
      ).expect(200);

      expect(await statusOf(transaction.id)).toBe("SUCCESS");
      expect(await legsOf(transaction.id)).toHaveLength(4);
      expect(
        await prisma.reconciliationRecord.findUniqueOrThrow({
          where: { providerReferenceId: settled.trackingId },
        }),
      ).toMatchObject({
        status: "SUCCESS",
        reconciliationStatus: "DISPUTED",
        disputeReason: "STATE_MISMATCH",
      });
    });
  });

  describe("disputes", () => {
    it("records an amount that differs from the held amount, and posts nothing", async () => {
      const user = await registerUser();
      const transaction = await pendingTransfer(user, "deposit", "100.00");
      const callback = callbackFor(transaction, { amount: "1000.00" });

      // Answered 2xx: an identical redelivery would meet an identical dispute.
      await deliver(JSON.stringify(callback)).expect(200);

      expect(await statusOf(transaction.id)).toBe("PENDING");
      expect(await legsOf(transaction.id)).toHaveLength(2);
      expect(await clearingBalance()).toBe("100.00");
      expect(
        await prisma.reconciliationRecord.findUniqueOrThrow({
          where: { providerReferenceId: callback.trackingId },
        }),
      ).toMatchObject({ reconciliationStatus: "DISPUTED", disputeReason: "AMOUNT_MISMATCH" });
    });

    it("records a callback for a transfer the engine does not hold", async () => {
      const user = await registerUser();
      const transaction = await pendingTransfer(user, "deposit", "100.00");
      const callback = callbackFor(transaction, { pspReferenceId: randomUUID() });

      await deliver(JSON.stringify(callback)).expect(200);

      expect(await statusOf(transaction.id)).toBe("PENDING");
      expect(
        await prisma.reconciliationRecord.findUniqueOrThrow({
          where: { providerReferenceId: callback.trackingId },
        }),
      ).toMatchObject({ reconciliationStatus: "DISPUTED", disputeReason: "UNKNOWN_REFERENCE" });
    });
  });

  describe("malformed callbacks", () => {
    it("answers 400 for a signed body that is not JSON", async () => {
      await deliver("not json").expect(400);

      expect(await prisma.webhookEvent.count()).toBe(0);
    });

    it("answers 400 for a rejection without a reason", async () => {
      const user = await registerUser();
      const transaction = await pendingTransfer(user, "deposit", "100.00");

      await deliver(
        JSON.stringify(callbackFor(transaction, { status: "REJECTED" })),
      ).expect(400);

      expect(await statusOf(transaction.id)).toBe("PENDING");
    });
  });
});
