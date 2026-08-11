import "dotenv/config";
import { prisma } from "@payments/db/client";
import { startRelay, stopRelay } from "./outbox/relay.js";

await startRelay();
console.log("outbox relay started");

const stop = async (): Promise<void> => {
  await stopRelay();
  await prisma.$disconnect();
  console.log("outbox relay stopped");
  process.exit(0);
};

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
