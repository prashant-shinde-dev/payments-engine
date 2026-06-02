import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import { prisma } from "@payments/db/client";
import { router as authRouter } from "./routes/auth.routes.js";

import { AppError } from "./errors/index.js";

const app = express();
const PORT = process.env.PORT || 3001;
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/api/v1/auth", authRouter);

app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: { code: err.code, message: err.message },
    });
  } else {
    console.error("[unhandled error]", err);
    res.status(500).json({
      success: false,
      error: { code: "UNKNOWN", message: "Something Went Wrong" },
    });
  }
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
