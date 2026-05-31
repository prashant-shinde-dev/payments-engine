import "dotenv/config";
import express from "express";
import { prisma } from "@payments/db/client";

const app = express();

const PORT = process.env.PORT || 3001;

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const server = app.listen(PORT, () => {
  console.log(`app running on ${PORT}`);
});
const shutdown = async () => {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
