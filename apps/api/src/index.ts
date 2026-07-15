import "dotenv/config";
import { prisma } from "@payments/db/client";
import { config } from "./config.js";
import { createApp } from "./app.js";

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`API listening on port ${config.port}`);
});

const shutdown = async (): Promise<void> => {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
