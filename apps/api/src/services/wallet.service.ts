import {
  HOUSE_USER_ID,
  CLEARING_ACC_USER_ID,
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

  // The Clearing is the counter-account for money crossing the system boundary, so a
  // deposit and a withdrawal are the same posting with the roles swapped.
  const isDeposit = direction === "deposit";
  const sender = isDeposit ? HOUSE_USER_ID : user;
  const receiver = CLEARING_ACC_USER_ID;
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
  const { fromUserId, toUserId } = getParties(type, user);

  const transaction = await recordTransaction(txn, {
    fromUserId,
    toUserId,
    type,
    status,
    amount: amt,
  });
  await postLedger(txn, {
    to: receiverWallet,
    from: senderWallet,
    amount: amt,
    transactionId: transaction.id,
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
    senderWallet.accountType !== "CUSTOMER" ||
    receiverWallet.accountType !== "CUSTOMER"
  ) {
    throw new NotFoundError("receiver's wallet could not be found");
  }
  if (amt.comparedTo(senderWallet.balance) > 0) {
    throw new InsufficientFundsError("insufficient funds to send money");
  }

  const transaction = await recordTransaction(txn, {
    fromUserId: sender,
    toUserId: receiver,
    type: "P2P_TRANSFER",
    status: "SUCCESS",
    amount: amt,
  });
  await postLedger(txn, {
    to: receiverWallet,
    from: senderWallet,
    amount: amt,
    transactionId: transaction.id,
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
    amount: Decimal;
    transactionId: string;
  },
): Promise<void> {
  const { to, from, amount, transactionId } = data;
  await txn.wallet.update({
    where: { userId: from.userId },
    data: { balance: { decrement: amount } },
  });
  await txn.wallet.update({
    where: { userId: to.userId },
    data: { balance: { increment: amount } },
  });

  const senderLedger = await txn.ledgerEntry.create({
    data: {
      transactionId,
      walletId: from.id,
      amount: amount.negated(),
    },
  });

  const receiverLedger = await txn.ledgerEntry.create({
    data: {
      transactionId,
      walletId: to.id,
      amount: amount,
    },
  });

  if (!senderLedger.amount.plus(receiverLedger.amount).isZero()) {
    throw new ConflictError("The Ledger does not conserve");
  }
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

function getParties(
  type: Extract<TransactionType, "BANK_DEPOSIT" | "BANK_WITHDRAWAL">,
  user: string,
): { fromUserId: string; toUserId: string } {
  switch (type) {
    case "BANK_DEPOSIT":
      return { fromUserId: HOUSE_USER_ID, toUserId: user };
    case "BANK_WITHDRAWAL":
      return { fromUserId: user, toUserId: HOUSE_USER_ID };
  }
}

async function recordTransaction(
  txn: Prisma.TransactionClient,
  data: {
    fromUserId: string;
    toUserId: string;
    type: TransactionType;
    status: TransactionStatus;
    amount: Decimal;
  },
): Promise<TransactionResult> {
  return await txn.transaction.create({
    data,
    include: {
      fromUser: { select: { firstName: true, lastName: true } },
      toUser: { select: { firstName: true, lastName: true } },
    },
  });
}
