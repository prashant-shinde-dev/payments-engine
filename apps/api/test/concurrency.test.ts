import { it, describe, expect } from "vitest";
import { getBalance, send } from "../src/services/wallet.service.js";
import { fundWallet, registerUser } from "./helpers.js";
import { InsufficientFundsError } from "../src/errors/index.js";

describe("concurrent requests", () => {
  it("rejects overdraft of amount under multiple concurrent transfers", async () => {
    const sender = await registerUser({ email: "senderC@test.local" });
    const receiver = await registerUser({ email: "receiverC@test.local" });
    await fundWallet(sender.user.id, "100");

    const result = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        send({
          sender: sender.user.id,
          receiver: receiver.user.id,
          amount: "20",
        }),
      ),
    );
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(
      result.filter(
        (r) =>
          r.status === "rejected" && r.reason instanceof InsufficientFundsError,
      ),
    ).toHaveLength(5);
    const s = await getBalance(sender.user.id);
    const r = await getBalance(receiver.user.id);
    expect(s.balance.toString()).toEqual("0");
    expect(r.balance.toString()).toEqual("100");
    expect(s.balance.plus(r.balance).toString()).toEqual("100");
  });

  it("prevents deadlock for concurrent mutual transfer (A -> B & B -> A)", async () => {
    const sender = await registerUser({ email: "senderDead@test.local" });
    const receiver = await registerUser({ email: "receiverDead@test.local" });
    await fundWallet(sender.user.id, "200");
    await fundWallet(receiver.user.id, "200");

    await Promise.all([
      send({
        sender: sender.user.id,
        receiver: receiver.user.id,
        amount: "100",
      }),
      send({
        sender: receiver.user.id,
        receiver: sender.user.id,
        amount: "200",
      }),
    ]);
    const s = await getBalance(sender.user.id);
    const r = await getBalance(receiver.user.id);
    expect(s.balance.toString()).toEqual("300");
    expect(r.balance.toString()).toEqual("100");
    expect(s.balance.plus(r.balance).toString()).toEqual("400");
  });
});
