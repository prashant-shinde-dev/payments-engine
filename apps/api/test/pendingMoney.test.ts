import { randomUUID } from "node:crypto";
import {
  CLEARING_ACC_USER_ID,
  CLEARING_ACC_WALLET_ID,
  HOUSE_USER_ID,
  HOUSE_WALLET_ID,
  prisma,
  TransactionStatus,
  TransactionType,
} from "@payments/db/client";
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

function bankTransfer(
  user: RegisteredUser,
  direction: "deposit" | "withdrawal",
  amount: string,
): request.Test {
  return request(app)
    .post("/api/v1/wallet/banktransfer")
    .send({ direction, amount })
    .set({
      authorization: authHeader(user.token).Authorization,
      IdempotencyKey: randomUUID(),
    });
}

function history(user: RegisteredUser): request.Test {
  return request(app)
    .get("/api/v1/wallet/transactions")
    .set(authHeader(user.token));
}

// The wire shape, not the row shape: amount and createdAt serialize to strings.
type HistoryRow = {
  id: string;
  type: TransactionType;
  status: TransactionStatus;
  fromUserId: string;
  toUserId: string;
  amount: string;
};

// Found by type rather than by index: orderBy createdAt cannot separate two rows written
// in the same millisecond, so a positional assertion would be a latent flake.
function rowOfType(rows: HistoryRow[], type: TransactionType): HistoryRow {
  const row = rows.find((candidate) => candidate.type === type);
  if (!row) {
    throw new Error(`no ${type} row in history`);
  }
  return row;
}

/**
 * The invariant the whole ledger design rests on, asserted for one wallet. Compared at
 * fixed scale so a failure prints the two amounts rather than "expected false to be true".
 */
async function expectProjectionMatchesLedger(walletId: string): Promise<void> {
  const wallet = await prisma.wallet.findUniqueOrThrow({
    where: { id: walletId },
  });
  const derived = await deriveBalance(walletId);
  expect(derived.toFixed(2)).toBe(
    new Decimal(wallet.balance.toString()).toFixed(2),
  );
}

async function walletIdOf(userId: string): Promise<string> {
  const { id } = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
  return id;
}

describe("money in flight", () => {
  describe("the invariant holds while a transfer is pending", () => {
    it("keeps every wallet a deposit touches consistent before it settles", async () => {
      const user = await registerUser();

      await bankTransfer(user, "deposit", "100.00").expect(201);

      // Nothing has settled — the transaction is still PENDING — and yet no wallet's
      // cached balance disagrees with the sum of its legs.
      const transaction = await prisma.transaction.findFirstOrThrow();
      expect(transaction.status).toBe("PENDING");

      await expectProjectionMatchesLedger(await walletIdOf(user.user.id));
      await expectProjectionMatchesLedger(HOUSE_WALLET_ID);
      await expectProjectionMatchesLedger(CLEARING_ACC_WALLET_ID);
    });

    it("keeps every wallet a withdrawal touches consistent before it settles", async () => {
      const user = await registerUser();
      await fundWallet(user.user.id, "500.00");

      await bankTransfer(user, "withdrawal", "120.00").expect(201);

      await expectProjectionMatchesLedger(await walletIdOf(user.user.id));
      await expectProjectionMatchesLedger(HOUSE_WALLET_ID);
      await expectProjectionMatchesLedger(CLEARING_ACC_WALLET_ID);
    });

    it("posts a balanced movement — the legs of the transfer sum to zero", async () => {
      const user = await registerUser();
      await fundWallet(user.user.id, "500.00");

      await bankTransfer(user, "withdrawal", "77.77").expect(201);

      const transfer = await prisma.transaction.findFirstOrThrow({
        where: { type: "BANK_WITHDRAWAL" },
      });
      const legs = await prisma.ledgerEntry.findMany({
        where: { transactionId: transfer.id },
      });
      const total = legs.reduce(
        (sum, leg) => sum.plus(leg.amount.toString()),
        new Decimal(0),
      );
      expect(legs).toHaveLength(2);
      expect(total.toFixed(2)).toBe("0.00");
    });
  });

  describe("money in flight is not spendable", () => {
    it("refuses a second withdrawal of funds already committed to the first", async () => {
      const user = await registerUser();
      await fundWallet(user.user.id, "100.00");

      await bankTransfer(user, "withdrawal", "80.00").expect(201);
      // The debit happened at submit, so the overdraft check that already existed does
      // this work — no separate hold mechanism, and no way to forget to apply it.
      await bankTransfer(user, "withdrawal", "80.00").expect(402);

      const wallet = await prisma.wallet.findUniqueOrThrow({
        where: { userId: user.user.id },
      });
      expect(new Decimal(wallet.balance.toString()).toFixed(2)).toBe("20.00");
      // The refused attempt posted nothing: clearing holds the first transfer only.
      expect((await deriveBalance(CLEARING_ACC_WALLET_ID)).toFixed(2)).toBe(
        "80.00",
      );
    });

    it("refuses a P2P transfer of funds already committed to a pending withdrawal", async () => {
      const sender = await registerUser();
      const receiver = await registerUser();
      await fundWallet(sender.user.id, "100.00");

      await bankTransfer(sender, "withdrawal", "80.00").expect(201);

      // A different code path entirely, and it must reach the same verdict — the hold is
      // a property of the balance, not of the endpoint that checked it.
      await request(app)
        .post("/api/v1/wallet/transfer")
        .send({ receiver: receiver.user.id, amount: "80.00" })
        .set({
          authorization: authHeader(sender.token).Authorization,
          IdempotencyKey: randomUUID(),
        })
        .expect(402);
    });

    it("accounts for everything in flight on the clearing account", async () => {
      const first = await registerUser();
      const second = await registerUser();
      await fundWallet(second.user.id, "500.00");

      await bankTransfer(first, "deposit", "100.00").expect(201);
      await bankTransfer(second, "withdrawal", "80.00").expect(201);

      const pending = await prisma.transaction.aggregate({
        where: { status: "PENDING" },
        _sum: { amount: true },
      });
      expect((await deriveBalance(CLEARING_ACC_WALLET_ID)).toFixed(2)).toBe(
        new Decimal(pending._sum.amount?.toString() ?? "0").toFixed(2),
      );
    });
  });

  describe("the clearing account's guardrails", () => {
    it("cannot be driven negative", async () => {
      // A negative clearing balance means money left it that never entered — a phantom
      // or double settlement. Nothing else in the system can detect that: the projection
      // would still match the legs, so reconciliation would pass on corrupt books.
      await expect(
        prisma.wallet.update({
          where: { id: CLEARING_ACC_WALLET_ID },
          data: { balance: { decrement: new Decimal("0.01") } },
        }),
      ).rejects.toThrow(/Wallet_balance_nonnegative/);
    });

    it("still lets the house account go negative", async () => {
      // The other half of the allowlist: the house carries the system's float and is
      // the one account for which a negative balance is meaningful.
      const house = await prisma.wallet.update({
        where: { id: HOUSE_WALLET_ID },
        data: { balance: { decrement: new Decimal("50.00") } },
      });
      expect(new Decimal(house.balance.toString()).toFixed(2)).toBe("-50.00");
    });

    it("cannot be paid into by a customer", async () => {
      const sender = await registerUser();
      await fundWallet(sender.user.id, "100.00");

      // Reachable only because the clearing account has a real, valid UUID that passes
      // request validation. The service guard is the thing standing in the way, and it
      // has to reject every non-customer account rather than the one it was written for.
      await request(app)
        .post("/api/v1/wallet/transfer")
        .send({ receiver: CLEARING_ACC_USER_ID, amount: "10.00" })
        .set({
          authorization: authHeader(sender.token).Authorization,
          IdempotencyKey: randomUUID(),
        })
        .expect(404);

      expect((await deriveBalance(CLEARING_ACC_WALLET_ID)).toFixed(2)).toBe(
        "0.00",
      );
    });
  });
  describe("", () => {
    it("aserts the response shape visible to the end user", async () => {
      const user = await registerUser();
      await fundWallet(user.user.id, "100.00");

      const withdrawal = await bankTransfer(user, "withdrawal", "80.00").expect(
        201,
      );
      const deposit = await bankTransfer(user, "deposit", "80.00").expect(201);
      expect(withdrawal.body).toEqual({
        data: {
          sender: "Test User",
          receiver: "System House",
          amount: new Decimal("80.00").toString(),
          timestamp: expect.any(String),
          status: "PENDING",
          type: "BANK_WITHDRAWAL",
        },
        success: true,
      });
      expect(deposit.body).toEqual({
        data: {
          sender: "System House",
          receiver: "Test User",
          amount: new Decimal("80.00").toString(),
          timestamp: expect.any(String),
          status: "PENDING",
          type: "BANK_DEPOSIT",
        },
        success: true,
      });
    });
  });

  describe("the customer's own history", () => {
    it("shows a deposit to the customer who received it", async () => {
      const user = await registerUser();

      await bankTransfer(user, "deposit", "100.00").expect(201);

      // The regression this locks: while the transaction named house -> clearing the
      // customer was on neither side, so this endpoint returned nothing at all.
      const { body } = await history(user).expect(200);
      const rows = body.data.transactions as HistoryRow[];

      expect(rowOfType(rows, "BANK_DEPOSIT")).toMatchObject({
        fromUserId: HOUSE_USER_ID,
        toUserId: user.user.id,
        status: "PENDING",
      });
    });

    it("shows a withdrawal to the customer who sent it", async () => {
      const user = await registerUser();
      await fundWallet(user.user.id, "500.00");

      await bankTransfer(user, "withdrawal", "120.00").expect(201);

      const { body } = await history(user).expect(200);
      const rows = body.data.transactions as HistoryRow[];

      expect(rowOfType(rows, "BANK_WITHDRAWAL")).toMatchObject({
        fromUserId: user.user.id,
        toUserId: HOUSE_USER_ID,
        status: "PENDING",
      });
    });

    it("never names a posting account as the customer's counterparty", async () => {
      const user = await registerUser();
      await fundWallet(user.user.id, "500.00");

      await bankTransfer(user, "deposit", "100.00").expect(201);
      await bankTransfer(user, "withdrawal", "120.00").expect(201);

      const { body } = await history(user).expect(200);
      const rows = body.data.transactions as HistoryRow[];
      const counterparties = rows.flatMap((row) => [
        row.fromUserId,
        row.toUserId,
      ]);

      // Clearing is where money sits mid-flight, not a party to anything. It belongs in
      // the legs and nowhere a customer can see - the whole reason Transaction carries
      // the intent rather than the accounts that moved.
      expect(counterparties).not.toContain(CLEARING_ACC_USER_ID);
      expect(rows).toHaveLength(3);
    });
  });
});
