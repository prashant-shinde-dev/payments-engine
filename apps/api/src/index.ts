import "dotenv/config";
import { prisma } from "@payments/db/client";
import { config } from "./config.js";
import { createApp } from "./app.js";
import { startReaper } from "./batch/removeExpiredKeys.js";

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`API listening on port ${config.port}`);
});

// Explicit start (importing the module has no side effect) — begins the hourly sweep.
startReaper();

const shutdown = async (): Promise<void> => {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
