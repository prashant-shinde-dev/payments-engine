import {
  HOUSE_USER_ID,
  Prisma,
  prisma,
  TransactionStatus,
  TransactionType,
  Wallet,
} from "@payments/db/client";
import type { BankTransferInputs as ValidatedBankTransfer } from "@payments/zod-schemas";
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
type TransferInputs = {
  sender: string;
  receiver: string;
  amount: string;
};

type BankTransferInputs = ValidatedBankTransfer & { user: string };

type TransferResult = {
  sender: string;
  receiver: string;
  amount: Decimal;
  timestamp: Date;
  status: TransactionStatus;
  type: TransactionType;
};

type TransactionResult = {
  fromUser: {
    firstName: string;
    lastName: string;
  };
  toUser: {
    firstName: string;
    lastName: string;
  };
} & {
  id: string;
  amount: Decimal;
  type: TransactionType;
  status: TransactionStatus;
  note: string | null;
  createdAt: Date;
  fromUserId: string;
  toUserId: string;
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

export async function send(data: TransferInputs): Promise<TransferResult> {
  const transaction = await prisma.$transaction(async (txn) => {
    return await transferCore(txn, data);
  });

  return transaction;
}

export async function bankTransfer(
  txn: Prisma.TransactionClient,
  data: BankTransferInputs,
): Promise<TransferResult> {
  const { user, amount, direction } = data;
  const amt = new Decimal(amount);

  // The house is the counter-account for money crossing the system boundary, so a
  // deposit and a withdrawal are the same posting with the roles swapped.
  const isDeposit = direction === "deposit";
  const sender = isDeposit ? HOUSE_USER_ID : user;
  const receiver = isDeposit ? user : HOUSE_USER_ID;
  const type: TransactionType = isDeposit ? "BANK_DEPOSIT" : "BANK_WITHDRAWAL";
  const status: TransactionStatus = "PENDING";

  const [senderWallet, receiverWallet] = await lockAndFetchWallets(txn, {
    sender,
    receiver,
  });
  if (
    senderWallet.accountType === "CUSTOMER" &&
    amt.comparedTo(senderWallet.balance) > 0
  ) {
    throw new InsufficientFundsError("insufficient funds to send money");
  }
  const transaction = await postLedger(txn, {
    to: receiverWallet,
    from: senderWallet,
    amt,
    type,
    status,
  });

  await writeOutbox(txn, {
    transactionId: transaction.id,
    type,
    status,
    userId: user,
    amount: amt,
  });

  return buildResult(transaction);
}

export async function transferCore(
  txn: Prisma.TransactionClient,
  data: TransferInputs,
): Promise<TransferResult> {
  const { sender, receiver, amount } = data;
  const amt = new Decimal(amount);

  if (sender === receiver) {
    throw new ConflictError("cant send money to self");
  }
  const [senderWallet, receiverWallet] = await lockAndFetchWallets(txn, {
    sender,
    receiver,
  });
  if (
    senderWallet.accountType === "SYSTEM" ||
    receiverWallet.accountType === "SYSTEM"
  ) {
    throw new NotFoundError("receiver's wallet could not be found");
  }
  if (amt.comparedTo(senderWallet.balance) > 0) {
    throw new InsufficientFundsError("insufficient funds to send money");
  }

  const transaction = await postLedger(txn, {
    to: receiverWallet,
    from: senderWallet,
    amt,
    type: "P2P_TRANSFER",
    status: "SUCCESS",
  });

  return buildResult(transaction);
}

function buildResult(transaction: TransactionResult): TransferResult {
  return {
    sender: `${transaction.fromUser.firstName} ${transaction.fromUser.lastName}`,
    receiver: `${transaction.toUser.firstName} ${transaction.toUser.lastName}`,
    amount: transaction.amount,
    timestamp: transaction.createdAt,
    status: transaction.status,
    type: transaction.type,
  };
}

async function lockAndFetchWallets(
  txn: Prisma.TransactionClient,
  data: { sender: string; receiver: string },
): Promise<[Wallet, Wallet]> {
  const { sender, receiver } = data;
  // Lock both wallet rows up front, ordered by the stable userId value (NOT the
  // sender/receiver role). A consistent global lock order means two opposite-
  // direction transfers can never each hold the row the other needs -> no deadlock.
  // This ORDER BY is load-bearing; do not remove it.
  await txn.$queryRaw<{ userId: string }[]>`
      SELECT "userId" FROM "Wallet"
      WHERE "userId" IN (${sender}, ${receiver})
      ORDER BY "userId" ASC
      FOR UPDATE
    `;

  const senderWallet = await txn.wallet.findUnique({
    where: { userId: sender },
  });
  const receiverWallet = await txn.wallet.findUnique({
    where: { userId: receiver },
  });
  if (!senderWallet) {
    throw new NotFoundError("sender's wallet could not be found");
  }
  if (!receiverWallet) {
    throw new NotFoundError("receiver's wallet could not be found");
  }
  return [senderWallet, receiverWallet];
}

async function postLedger(
  txn: Prisma.TransactionClient,
  data: {
    to: Wallet;
    from: Wallet;
    amt: Decimal;
    type: TransactionType;
    status: TransactionStatus;
  },
): Promise<TransactionResult> {
  const { to, from, amt, type, status } = data;
  if (type === "P2P_TRANSFER") {
    await txn.wallet.update({
      where: { userId: from.userId },
      data: { balance: { decrement: amt } },
    });
    await txn.wallet.update({
      where: { userId: to.userId },
      data: { balance: { increment: amt } },
    });
  }

  const transaction = await txn.transaction.create({
    data: {
      fromUserId: from.userId,
      toUserId: to.userId,
      type,
      status,
      amount: amt,
    },
    include: {
      fromUser: { select: { firstName: true, lastName: true } },
      toUser: { select: { firstName: true, lastName: true } },
    },
  });

  const senderLedger = await txn.ledgerEntry.create({
    data: {
      transactionId: transaction.id,
      walletId: from.id,
      amount: amt.negated(),
    },
  });

  const receiverLedger = await txn.ledgerEntry.create({
    data: {
      transactionId: transaction.id,
      walletId: to.id,
      amount: amt,
    },
  });

  if (!senderLedger.amount.plus(receiverLedger.amount).isZero()) {
    throw new ConflictError("The Ledger does not conserve");
  }
  return transaction;
}

async function writeOutbox(
  txn: Prisma.TransactionClient,
  data: {
    transactionId: string;
    type: TransactionType;
    status: TransactionStatus;
    userId: string;
    amount: Decimal;
  },
): Promise<void> {
  const { transactionId, type, status, userId, amount } = data;
  await txn.transactionOutbox.create({
    data: {
      transactionId,
      type,
      status,
      userId,
      amount,
    },
  });
}
