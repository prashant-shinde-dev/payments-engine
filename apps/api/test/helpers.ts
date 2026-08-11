import request from "supertest";
import { randomUUID } from "node:crypto";
import { HOUSE_USER_ID, HOUSE_WALLET_ID, prisma } from "@payments/db/client";
import { createApp } from "../src/app.js";
import type { SafeUser } from "@payments/types";
import { Decimal } from "decimal.js";

/**
 * One shared in-process app for the whole suite. Supertest drives it directly —
 * no port is ever bound.
 */
export const app = createApp();

export interface RegisteredUser {
  user: SafeUser;
  token: string;
  password: string;
}

let phoneCounter = 1;

/**
 * Registers a user through the PUBLIC API — the same path a real client takes —
 * so tests exercise routing, validation, and the service together. Overrides let
 * a test pin an email/phone it wants to collide on; everything else is unique.
 */
export async function registerUser(
  overrides: Partial<{
    firstName: string;
    lastName: string;
    phoneNumber: string;
    email: string;
    password: string;
  }> = {},
): Promise<RegisteredUser> {
  const password = overrides.password ?? "Test1234";
  const body = {
    firstName: overrides.firstName ?? "Test",
    lastName: overrides.lastName ?? "User",
    phoneNumber:
      overrides.phoneNumber ?? `+31${String(phoneCounter++).padStart(10, "0")}`,
    email: overrides.email ?? `user-${randomUUID()}@test.local`,
    password,
  };

  const res = await request(app)
    .post("/api/v1/auth/register")
    .send(body)
    .expect(201);

  return {
    user: res.body.data.user as SafeUser,
    token: res.body.data.token as string,
    password,
  };
}

export function authHeader(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

// Funds a wallet as a balanced house->user opening movement so SUM(legs) matches the
// cached balance. Deliberately not routed through postLedger: a fixture that shares the
// production write path can't be trusted to prove the production write path is correct.
export async function fundWallet(
  userId: string,
  amount: string,
): Promise<void> {
  const amt = new Decimal(amount);
  await prisma.$transaction(async (txn) => {
    const userWallet = await txn.wallet.update({
      where: { userId },
      data: { balance: { increment: amt } },
    });
    await txn.wallet.update({
      where: { id: HOUSE_WALLET_ID },
      data: { balance: { decrement: amt } },
    });
    const transaction = await txn.transaction.create({
      data: {
        fromUserId: HOUSE_USER_ID,
        toUserId: userId,
        amount: amt,
        type: "OPENING_BALANCE",
        status: "SUCCESS",
      },
    });
    await txn.ledgerEntry.create({
      data: {
        walletId: userWallet.id,
        transactionId: transaction.id,
        amount: amt,
      },
    });
    await txn.ledgerEntry.create({
      data: {
        walletId: HOUSE_WALLET_ID,
        transactionId: transaction.id,
        amount: amt.negated(),
      },
    });
  });
}

// SUM of a wallet's legs; Decimal(0) when it has none.
export async function deriveBalance(walletId: string): Promise<Decimal> {
  const { _sum } = await prisma.ledgerEntry.aggregate({
    where: { walletId },
    _sum: { amount: true },
  });
  return new Decimal(_sum.amount?.toString() ?? "0");
}
