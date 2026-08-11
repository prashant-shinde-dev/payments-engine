import "dotenv/config";
import { prisma } from "@payments/db/client";
import { createBankTransferConsumer } from "./outbox/consumer.js";

const consumer = createBankTransferConsumer();
console.log("bank transfer worker started");

const stop = async (): Promise<void> => {
  await consumer.close();
  await prisma.$disconnect();
  console.log("bank transfer worker stopped");
  process.exit(0);
};

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
