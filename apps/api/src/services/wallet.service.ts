import {
  prisma,
  TransactionStatus,
  TransactionType,
} from "@payments/db/client";
import { Decimal } from "decimal.js";

import {
  ConflictError,
  InsufficientFundsError,
  NotFoundError,
} from "../errors/index.js";

type TransactionRecord = {
  id: string;
  createdAt: Date;
  fromUserId: string;
  toUserId: string;
  amount: Decimal;
  type: TransactionType;
  status: TransactionStatus;
  note: string | null;
};

type TransactionHistory = {
  transactions: TransactionRecord[];
  total: number;
};

type TransferResult = {
  sender: string;
  receiver: string;
  timestamp: Date;
  amount: Decimal;
  status: TransactionStatus;
  type: TransactionType;
};

export async function getBalance(
  userId: string,
): Promise<{ balance: Decimal }> {
  const wallet = await prisma.wallet.findUnique({
    where: { userId },
    select: { balance: true },
  });
  if (!wallet) {
    throw new NotFoundError("Wallet not found");
  }
  return wallet;
}

export async function getTransactions(
  userId: string,
  page: number = 1,
  pageSize: number = 10,
): Promise<TransactionHistory> {
  const where = { OR: [{ fromUserId: userId }, { toUserId: userId }] };

  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: "desc" },
    }),
    prisma.transaction.count({ where }),
  ]);

  return { transactions, total };
}

export async function send(data: {
  sender: string;
  receiver: string;
  amount: string;
}): Promise<TransferResult> {
  const { sender, receiver, amount } = data;
  const amt = new Decimal(amount);

  if (sender === receiver) {
    throw new ConflictError("cant send money to self");
  }

  const transaction = await prisma.$transaction(async (txn) => {
    // Lock both wallet rows up front, ordered by the stable userId value (NOT the
    // sender/receiver role). A consistent global lock order means two opposite-
    // direction transfers can never each hold the row the other needs -> no deadlock.
    // This ORDER BY is load-bearing; do not remove it.
    const lockedRows = await txn.$queryRaw<{ userId: string }[]>`
      SELECT "userId" FROM "Wallet"
      WHERE "userId" IN (${sender}, ${receiver})
      ORDER BY "userId" ASC
      FOR UPDATE
    `;

    if (!lockedRows.some((row) => row.userId === receiver)) {
      throw new NotFoundError("receiver's wallet could not be found");
    }

    const senderWallet = await txn.wallet.findUnique({
      where: { userId: sender },
      select: { balance: true },
    });
    if (!senderWallet) {
      throw new NotFoundError("sender's wallet could not be found");
    }
    if (amt.comparedTo(senderWallet.balance) > 0) {
      throw new InsufficientFundsError("insufficient funds to send money");
    }

    await txn.wallet.update({
      where: { userId: sender },
      data: { balance: { decrement: amt } },
    });
    await txn.wallet.update({
      where: { userId: receiver },
      data: { balance: { increment: amt } },
    });

    return txn.transaction.create({
      data: {
        fromUserId: sender,
        toUserId: receiver,
        type: "P2P_TRANSFER",
        status: "SUCCESS",
        amount: amt,
      },
      include: {
        fromUser: { select: { firstName: true, lastName: true } },
        toUser: { select: { firstName: true, lastName: true } },
      },
    });
  });

  return {
    sender: `${transaction.fromUser.firstName} ${transaction.fromUser.lastName}`,
    receiver: `${transaction.toUser.firstName} ${transaction.toUser.lastName}`,
    timestamp: transaction.createdAt,
    amount: transaction.amount,
    status: transaction.status,
    type: transaction.type,
  };
}
