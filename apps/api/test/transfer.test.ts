import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, authHeader, fundWallet, registerUser } from "./helpers.js";
import { getBalance } from "../src/services/wallet.service.js";
import { randomUUID } from "node:crypto";
import { prisma } from "@payments/db/client";

describe("POST /api/v1/wallet/transfer", () => {
  it("checks a successful transfer of money between two genuine users", async () => {
    const sender = await registerUser({
      email: "sender@test.local",
      firstName: "sender",
      lastName: "user",
    });
    const receiver = await registerUser({
      email: "receiver@test.local",
      firstName: "receiver",
      lastName: "user",
    });
    await fundWallet(sender.user.id, "400");
    const { Authorization } = authHeader(sender.token);
    const res = await request(app)
      .post("/api/v1/wallet/transfer")
      .send({
        receiver: receiver.user.id,
        amount: "100",
      })
      .set({ authorization: Authorization, IdempotencyKey: randomUUID() })
      .expect(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      sender: "sender user",
      receiver: "receiver user",
      amount: "100",
      status: "SUCCESS",
    });
    expect((await getBalance(sender.user.id)).balance.toString()).toEqual(
      "300",
    );
    expect((await getBalance(receiver.user.id)).balance.toString()).toEqual(
      "100",
    );
    expect(
      await prisma.transaction.count({
        where: {
          fromUserId: sender.user.id,
          toUserId: receiver.user.id,
          status: "SUCCESS",
        },
      }),
    ).toBe(1);
  });

  it("derives the sender from the token, ignoring a sender claimed in the body", async () => {
    const tokenHolder = await registerUser({
      email: "sender@test.local",
      firstName: "sender",
      lastName: "user",
    });
    const impersonated = await registerUser({
      email: "senderB@test.local",
      firstName: "senderB",
      lastName: "userB",
    });
    const receiver = await registerUser({
      email: "receiver@test.local",
      firstName: "receiver",
      lastName: "user",
    });
    await fundWallet(tokenHolder.user.id, "400");
    await fundWallet(impersonated.user.id, "400");

    const { Authorization } = authHeader(tokenHolder.token);
    const res = await request(app)
      .post("/api/v1/wallet/transfer")
      .send({
        sender: impersonated.user.id,
        receiver: receiver.user.id,
        amount: "100",
      })
      .set({ authorization: Authorization, IdempotencyKey: randomUUID() })
      .expect(201);

    expect((await getBalance(impersonated.user.id)).balance.toString()).toEqual(
      "400",
    );

    expect((await getBalance(tokenHolder.user.id)).balance.toString()).toEqual(
      "300",
    );
    expect((await getBalance(receiver.user.id)).balance.toString()).toEqual(
      "100",
    );

    expect(res.body.data.sender).toBe("sender user");
    expect(
      await prisma.transaction.count({
        where: {
          fromUserId: tokenHolder.user.id,
          toUserId: receiver.user.id,
        },
      }),
    ).toBe(1);
  });

  it("checks the unsuccessful transfer when there are insufficient funds", async () => {
    const sender = await registerUser({
      email: "sender@test.local",
      firstName: "sender",
      lastName: "user",
    });
    const receiver = await registerUser({
      email: "receiver@test.local",
      firstName: "receiver",
      lastName: "user",
    });
    await fundWallet(sender.user.id, "400");
    const { Authorization } = authHeader(sender.token);
    const res = await request(app)
      .post("/api/v1/wallet/transfer")
      .send({
        receiver: receiver.user.id,
        amount: "500",
      })
      .set({ authorization: Authorization, IdempotencyKey: randomUUID() })
      .expect(402);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("INSUFFICIENT_FUNDS");
    expect((await getBalance(sender.user.id)).balance.toString()).toEqual(
      "400",
    );
    expect((await getBalance(receiver.user.id)).balance.toString()).toEqual(
      "0",
    );
    expect(
      await prisma.transaction.count({
        where: { fromUserId: sender.user.id, toUserId: receiver.user.id },
      }),
    ).toEqual(0);
  });

  it("checks the unsuccessful transfer upon self transfer", async () => {
    const sender = await registerUser({
      email: "sender@test.local",
      firstName: "sender",
      lastName: "user",
    });
    const { Authorization } = authHeader(sender.token);

    const res = await request(app)
      .post("/api/v1/wallet/transfer")
      .send({
        receiver: sender.user.id,
        amount: "200",
      })
      .set({ authorization: Authorization, IdempotencyKey: randomUUID() })
      .expect(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect((await getBalance(sender.user.id)).balance.toString()).toEqual("0");
    expect(
      await prisma.transaction.count({
        where: { fromUserId: sender.user.id },
      }),
    ).toEqual(0);
  });

  it("rejects the transfer when receiver's wallet does not exist", async () => {
    const sender = await registerUser({
      email: "sender@test.local",
      firstName: "sender",
      lastName: "user",
    });
    const { Authorization } = authHeader(sender.token);
    const res = await request(app)
      .post("/api/v1/wallet/transfer")
      .send({
        receiver: randomUUID(),
        amount: "400",
      })
      .set({ authorization: Authorization, IdempotencyKey: randomUUID() })
      .expect(404);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect((await getBalance(sender.user.id)).balance.toString()).toEqual("0");
    expect(
      await prisma.transaction.count({
        where: { fromUserId: sender.user.id },
      }),
    ).toEqual(0);
  });
});
