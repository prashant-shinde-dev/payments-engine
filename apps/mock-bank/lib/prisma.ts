import "dotenv/config";
import {
  Prisma,
  PrismaClient,
  type TransferRequest,
  type RejectionReason,
  type TransactionEvent,
  type Status,
  type DeliveryStatus,
} from "./generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { config } from "../src/config.js";
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: config.databaseUrl }),
  });

if (process.env.NODE_ENV != "Production") globalForPrisma.prisma = prisma;

export type {
  TransferRequest,
  RejectionReason,
  TransactionEvent,
  Status,
  DeliveryStatus,
};
export { Prisma };
