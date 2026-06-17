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

export async function getBalance(
  userId: string,
): Promise<{ balance: Decimal }> {
  const balance = await prisma.wallet.findUnique({
    select: {
      balance: true,
    },
    where: {
      userId,
    },
  });
  if (!balance) {
    throw new NotFoundError("Wallet not found");
  }

  return balance;
}

export async function getTransactions(
  userId: string,
  page: number = 1,
  pageSize: number = 10,
): Promise<{
  transactions: {
    id: string;
    createdAt: Date;
    fromUserId: string;
    toUserId: string;
    amount: Decimal;
    type: TransactionType;
    status: TransactionStatus;
    note: string | null;
  }[];
  total: number;
}> {
  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({
      skip: (page - 1) * pageSize,
      take: pageSize,
      where: {
        OR: [{ fromUserId: userId }, { toUserId: userId }],
      },
      orderBy: {
        createdAt: "desc",
      },
    }),
    prisma.transaction.count({
      where: {
        OR: [{ fromUserId: userId }, { toUserId: userId }],
      },
    }),
  ]);

  return { transactions, total };
}

export async function send(data: {
  sender: string;
  receiver: string;
  amount: string;
}): Promise<{
  sender: string;
  receiver: string;
  timestamp: Date;
  amount: Decimal;
  status: TransactionStatus;
  type: TransactionType;
}> {
  const { sender, receiver, amount } = data;
  const amt = new Decimal(amount);

  if (receiver === sender) {
    throw new ConflictError("cant send money to self");
  }
  const receiverWallet = await prisma.wallet.findUnique({
    where: {
      userId: receiver,
    },
    select: {
      id: true,
    },
  });

  if (!receiverWallet) {
    throw new NotFoundError("receiver's wallet could not be found");
  }
  const senderWallet = await prisma.wallet.findUnique({
    where: {
      userId: sender,
    },
    select: {
      balance: true,
    },
  });

  if (!senderWallet) {
    throw new NotFoundError("sender's wallet could not be found");
  }

  if (amt.comparedTo(senderWallet.balance) > 0) {
    throw new InsufficientFundsError("insufficient funds to send money");
  }

  const transaction = await prisma.$transaction(async (txn) => {
    await txn.wallet.update({
      where: {
        userId: receiver,
      },
      data: {
        balance: {
          increment: amt,
        },
      },
    });

    await txn.wallet.update({
      where: {
        userId: sender,
      },
      data: {
        balance: {
          decrement: amt,
        },
      },
    });
    const createdTxn = await txn.transaction.create({
      data: {
        toUserId: receiver,
        fromUserId: sender,
        type: "P2P_TRANSFER",
        status: "SUCCESS",
        amount: amt,
      },
      include: {
        fromUser: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
        toUser: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
      },
    });
    return createdTxn;
  });
  const transactionDetails = {
    sender: `${transaction.fromUser.firstName} ${transaction.fromUser.lastName}`,
    receiver: `${transaction.toUser.firstName} ${transaction.toUser.lastName}`,
    timestamp: transaction.createdAt,
    amount: transaction.amount,
    status: transaction.status,
    type: transaction.type,
  };

  return transactionDetails;
}
