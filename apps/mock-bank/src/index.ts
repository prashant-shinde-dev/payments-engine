import "dotenv/config";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { router } from "./routes/route.js";
import { prisma } from "../lib/prisma.js";
import { AppError } from "./errors/index.js";

const app = express();

app.get("/health", (req: Request, res: Response) => {
  res.json("OK");
});

app.use(
  "/api/v1",
  express.raw({ type: "application/json", limit: "64kb" }),
  router,
);
const server = app.listen("8080", () => {
  console.log("app is listening on port 8080");
});

app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  } else {
    console.error("[unhandled error]", err);
    res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Something Went Wrong" },
    });
  }
});

async function shutdown() {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
