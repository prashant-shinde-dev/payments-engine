import { PrismaClient } from "./generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export type {
  PrismaClient,
  TransactionStatus,
  TransactionType,
  Wallet,
  Transaction,
  TransactionOutbox,
} from "./generated/prisma/client.js";

export { Prisma } from "./generated/prisma/client.js";

export {
  HOUSE_USER_ID,
  HOUSE_WALLET_ID,
  CLEARING_ACC_USER_ID,
  CLEARING_ACC_WALLET_ID,
} from "./constants.js";
