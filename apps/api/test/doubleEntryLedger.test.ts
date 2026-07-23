import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { prisma } from "@payments/db/client";
import { deriveBalance, fundWallet, registerUser } from "./helpers.ts";
import { send } from "../src/services/wallet.service.ts";

describe("double-entry ledger", () => {
  it("keeps each wallet's balance equal to the sum of its ledger legs", async () => {
    const sender = await registerUser({ email: "sender@test.local" });
    const receiver = await registerUser({ email: "receiver@test.local" });
    await fundWallet(sender.user.id, "5000");

    // Promise.all, not allSettled — a rejected transfer must fail the test.
    await Promise.all(
      ["20", "100", "250", "1000", "30.50"].map((amount) =>
        send({ sender: sender.user.id, receiver: receiver.user.id, amount }),
      ),
    );

    const sw = await prisma.wallet.findUniqueOrThrow({
      where: { userId: sender.user.id },
    });
    const rw = await prisma.wallet.findUniqueOrThrow({
      where: { userId: receiver.user.id },
    });

    expect((await deriveBalance(sw.id)).equals(sw.balance.toString())).toBe(
      true,
    );
    expect((await deriveBalance(rw.id)).equals(rw.balance.toString())).toBe(
      true,
    );
  });

  it("conserves money: every ledger leg across all wallets sums to zero", async () => {
    const sender = await registerUser({ email: "sender@test.local" });
    const receiver = await registerUser({ email: "receiver@test.local" });
    await fundWallet(sender.user.id, "5000");
    await send({
      sender: sender.user.id,
      receiver: receiver.user.id,
      amount: "1234.56",
    });

    const { _sum } = await prisma.ledgerEntry.aggregate({
      _sum: { amount: true },
    });
    expect(new Decimal(_sum.amount?.toString() ?? "0").isZero()).toBe(true);
  });

  it("preserves exact decimal precision at large magnitudes (no float drift)", async () => {
    const sender = await registerUser({ email: "sender@test.local" });
    const receiver = await registerUser({ email: "receiver@test.local" });
    // Large magnitudes: a stray float coercion would drift the cents and fail below.
    await fundWallet(sender.user.id, "9999999999999999.99");
    await send({
      sender: sender.user.id,
      receiver: receiver.user.id,
      amount: "1234567890123456.78",
    });

    const sw = await prisma.wallet.findUniqueOrThrow({
      where: { userId: sender.user.id },
    });
    const rw = await prisma.wallet.findUniqueOrThrow({
      where: { userId: receiver.user.id },
    });

    expect((await deriveBalance(sw.id)).equals(sw.balance.toString())).toBe(
      true,
    );
    expect((await deriveBalance(rw.id)).equals(rw.balance.toString())).toBe(
      true,
    );

    const { _sum } = await prisma.ledgerEntry.aggregate({
      _sum: { amount: true },
    });
    expect(new Decimal(_sum.amount?.toString() ?? "0").isZero()).toBe(true);
  });
  it("rejects UPDATE and DELETE on a posted ledger entry (append-only)", async () => {
    const sender = await registerUser({ email: "sender@test.local" });
    const receiver = await registerUser({ email: "receiver@test.local" });
    await fundWallet(sender.user.id, "5000");
    await send({
      sender: sender.user.id,
      receiver: receiver.user.id,
      amount: "1234.56",
    });

    // A real, existing leg — so any rejection below is the immutability trigger,
    // not a "record not found". Capture its amount to prove it never changes.
    const leg = await prisma.ledgerEntry.findFirstOrThrow();
    const originalAmount = leg.amount.toString();

    // UPDATE is refused by the BEFORE UPDATE trigger.
    await expect(
      prisma.ledgerEntry.update({
        where: { id: leg.id },
        data: { amount: new Decimal("1111") },
      }),
    ).rejects.toThrow(/append-only/i);

    // DELETE is refused by the BEFORE DELETE trigger.
    await expect(
      prisma.ledgerEntry.delete({ where: { id: leg.id } }),
    ).rejects.toThrow(/append-only/i);

    // The row is untouched by either attempt: same amount, still present.
    const after = await prisma.ledgerEntry.findUniqueOrThrow({
      where: { id: leg.id },
    });
    expect(after.amount.toString()).toEqual(originalAmount);
  });
});
