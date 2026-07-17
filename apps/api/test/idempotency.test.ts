import { describe, it, expect } from "vitest";
import { authHeader, fundWallet, registerUser } from "./helpers.js";
import { createApp } from "../src/app.js";
import { runIdempotent } from "../src/services/idempotency.js";
import { createHash, randomUUID } from "node:crypto";
import { getBalance, transferCore } from "../src/services/wallet.service.js";
import { prisma } from "@payments/db/client";
import request from "supertest";
import { reapExpiredRecords } from "../src/batch/removeExpiredKeysJob.js";
import { number, record } from "zod";

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

describe("remove expired idempotent key records", () => {
  it("removes idempotency keys after 24 hours", async () => {
    const sender = await registerUser({ email: "sender@test.local" });
    const receiver = await registerUser({ email: "receiver@test.local" });
    await fundWallet(sender.user.id, "500");
    const idempotencyKey1 = randomUUID();
    const idempotencyKey2 = randomUUID();
    const idempotencyKey3 = randomUUID();
    const idempotencyKey4 = randomUUID();
    const idempotencyKey5 = randomUUID();

    await runIdempotent(sender.user.id, idempotencyKey1, transferCore, {
      sender: sender.user.id,
      receiver: receiver.user.id,
      amount: "50",
    });
    await runIdempotent(sender.user.id, idempotencyKey2, transferCore, {
      sender: sender.user.id,
      receiver: receiver.user.id,
      amount: "50",
    });
    await runIdempotent(sender.user.id, idempotencyKey3, transferCore, {
      sender: sender.user.id,
      receiver: receiver.user.id,
      amount: "50",
    });
    await runIdempotent(sender.user.id, idempotencyKey4, transferCore, {
      sender: sender.user.id,
      receiver: receiver.user.id,
      amount: "50",
    });
    await runIdempotent(sender.user.id, idempotencyKey5, transferCore, {
      sender: sender.user.id,
      receiver: receiver.user.id,
      amount: "50",
    });

    await prisma.$executeRaw`
    UPDATE "IdempotencyRecord" 
    SET "createdAt"= "createdAt" - INTERVAL '24 hours'
    WHERE (
        ("userId"= ${sender.user.id} AND "idempotencyKey" = ${idempotencyKey1})
    OR  ("userId"= ${sender.user.id} AND "idempotencyKey" = ${idempotencyKey2})
    )
    `;
    await prisma.$executeRaw`
    UPDATE "IdempotencyRecord" 
    SET "createdAt"= "createdAt" - INTERVAL '28 hours'
    WHERE (
        ("userId"= ${sender.user.id} AND "idempotencyKey" = ${idempotencyKey3})
    
    )
    `;
    await prisma.$executeRaw`
    UPDATE "IdempotencyRecord" 
    SET "createdAt"= "createdAt" - INTERVAL '6 hours'
    WHERE (
        ("userId"= ${sender.user.id} AND "idempotencyKey" = ${idempotencyKey4})
    OR  ("userId"= ${sender.user.id} AND "idempotencyKey" = ${idempotencyKey5})
    )
    `;
    const deleted = await reapExpiredRecords();

    // Direct blast radius: assert by identity BEFORE the re-runs below re-create
    // rows for the reaped keys. Exactly the records aged >= 24h are gone; every
    // record still inside the window survives. This is what catches a reaper that
    // deletes the right *count* but the wrong *set* (e.g. taking a live key).
    const keyExists = async (idempotencyKey: string): Promise<boolean> =>
      (await prisma.idempotencyRecord.count({
        where: { userId: sender.user.id, idempotencyKey },
      })) === 1;

    expect(await keyExists(idempotencyKey1)).toBe(false); // 24h old → reaped
    expect(await keyExists(idempotencyKey2)).toBe(false); // 24h old → reaped
    expect(await keyExists(idempotencyKey3)).toBe(false); // 28h old → reaped
    expect(await keyExists(idempotencyKey4)).toBe(true); //  6h old → kept
    expect(await keyExists(idempotencyKey5)).toBe(true); //  6h old → kept

    await runIdempotent(sender.user.id, idempotencyKey2, transferCore, {
      sender: sender.user.id,
      receiver: receiver.user.id,
      amount: "50",
    });
    await runIdempotent(sender.user.id, idempotencyKey3, transferCore, {
      sender: sender.user.id,
      receiver: receiver.user.id,
      amount: "50",
    });
    await runIdempotent(sender.user.id, idempotencyKey4, transferCore, {
      sender: sender.user.id,
      receiver: receiver.user.id,
      amount: "50",
    });
    const s = await getBalance(sender.user.id);
    const r = await getBalance(receiver.user.id);
    expect(deleted).toBe(3);
    expect(s.balance.toString()).toEqual("150");
    expect(r.balance.toString()).toEqual("350");
  });

  it("drains all expired records across multiple batches", async () => {
    const sender = await registerUser({ email: "sender@test.local" });
    const records = [];
    for (let i = 1; i <= 30; i++) {
      const idempotencyKey = randomUUID();
      let createdAt = new Date();

      if (i <= 15) {
        createdAt.setHours(createdAt.getHours() - 24);
      } else if (i > 15 && i <= 25) {
        createdAt.setHours(createdAt.getHours() - 28);
      } else if (i > 25 && i <= 30) {
        createdAt.setHours(createdAt.getHours() - 20);
      }

      records.push({
        idempotencyKey,
        userId: sender.user.id,
        requestHash: createHash("sha256").update("sha256").digest("hex"),
        createdAt, // explicit — overrides @default(now()) to fake age for the reaper
      });
    }
    await prisma.idempotencyRecord.createMany({ data: records });
    const deleted = await reapExpiredRecords(5);

    expect(deleted).toBe(25);
    expect(await prisma.idempotencyRecord.count()).toBe(5);
  });
});
