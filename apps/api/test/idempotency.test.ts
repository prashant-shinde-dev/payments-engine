import { describe, it, expect } from "vitest";
import { authHeader, fundWallet, registerUser } from "./helpers.js";
import { createApp } from "../src/app.js";
import { runIdempotent } from "../src/services/idempotency.js";
import { randomUUID } from "node:crypto";
import { getBalance, transferCore } from "../src/services/wallet.service.js";
import { prisma } from "@payments/db/client";
import request from "supertest";

const app = createApp();
describe("idempotency checks", () => {
  it("returns stored response for the retry request without re-computing for same idempotency key", async () => {
    const sender = await registerUser({ email: "sender@test.local" });
    const receiver = await registerUser({ email: "receiver@test.local" });
    await fundWallet(sender.user.id, "500");
    await fundWallet(receiver.user.id, "500");
    const idempotencyKey = randomUUID();
    const { Authorization } = authHeader(sender.token);

    const [r1, r2] = await Promise.all([
      request(app)
        .post("/api/v1/wallet/transfer")
        .send({
          receiver: receiver.user.id,
          amount: "100",
        })
        .set({ authorization: Authorization, IdempotencyKey: idempotencyKey })
        .expect(201),

      request(app)
        .post("/api/v1/wallet/transfer")
        .send({
          receiver: receiver.user.id,
          amount: "100",
        })
        .set({ authorization: Authorization, IdempotencyKey: idempotencyKey })
        .expect(201),
    ]);

    const s = await getBalance(sender.user.id);
    const r = await getBalance(receiver.user.id);
    expect(s.balance.toString()).toEqual("400");
    expect(r.balance.toString()).toEqual("600");
    expect(
      await prisma.transaction.count({
        where: {
          fromUserId: sender.user.id,
          toUserId: receiver.user.id,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.idempotencyRecord.count({
        where: { idempotencyKey, userId: sender.user.id },
      }),
    ).toBe(1);
    expect(r2.body).toEqual(r1.body);
  });

  it("executes and returns corrospoding response for distinct requests with distinct idempotency key", async () => {
    const sender = await registerUser({ email: "sender@test.local" });
    const receiver = await registerUser({ email: "receiver@test.local" });
    await fundWallet(sender.user.id, "500");
    await fundWallet(receiver.user.id, "500");
    const idempotencyKey1 = randomUUID();
    const idempotencyKey2 = randomUUID();

    await runIdempotent(sender.user.id, idempotencyKey1, transferCore, {
      sender: sender.user.id,
      receiver: receiver.user.id,
      amount: "100",
    });
    await runIdempotent(sender.user.id, idempotencyKey2, transferCore, {
      sender: sender.user.id,
      receiver: receiver.user.id,
      amount: "100",
    });

    const s = await getBalance(sender.user.id);
    const r = await getBalance(receiver.user.id);

    expect(s.balance.toString()).toEqual("300");
    expect(r.balance.toString()).toEqual("700");
    expect(
      await prisma.transaction.count({
        where: {
          fromUserId: sender.user.id,
          toUserId: receiver.user.id,
        },
      }),
    ).toBe(2);
    expect(
      await prisma.idempotencyRecord.count({
        where: {
          OR: [
            { userId: sender.user.id, idempotencyKey: idempotencyKey1 },
            { userId: sender.user.id, idempotencyKey: idempotencyKey2 },
          ],
        },
      }),
    ).toBe(2);
  });

  it("throws conflict of response for existing idempotent request but different operation", async () => {
    const sender = await registerUser({ email: "sender@test.local" });
    const receiver = await registerUser({ email: "receiver@test.local" });
    await fundWallet(sender.user.id, "500");
    await fundWallet(receiver.user.id, "500");
    const idempotencyKey = randomUUID();

    await runIdempotent(sender.user.id, idempotencyKey, transferCore, {
      sender: sender.user.id,
      receiver: receiver.user.id,
      amount: "100",
    });

    await expect(
      runIdempotent(sender.user.id, idempotencyKey, transferCore, {
        sender: sender.user.id,
        receiver: receiver.user.id,
        amount: "50",
      }),
    ).rejects.toThrow("key reused for a different request");
    const s = await getBalance(sender.user.id);
    const r = await getBalance(receiver.user.id);

    expect(s.balance.toString()).toEqual("400");
    expect(r.balance.toString()).toEqual("600");
    expect(
      await prisma.transaction.count({
        where: {
          fromUserId: sender.user.id,
          toUserId: receiver.user.id,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.idempotencyRecord.count({
        where: { userId: sender.user.id, idempotencyKey },
      }),
    ).toBe(1);
  });
});
