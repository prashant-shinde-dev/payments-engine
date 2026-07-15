import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { router as authRouter } from "./routes/auth.routes.js";
import { router as walletRouter } from "./routes/wallet.route.js";
import { AppError } from "./errors/index.js";
import { authenticate } from "./middleware/auth.middleware.js";

/**
 * Builds the Express application with routes and the error handler wired up.
 *
 * Importing this module has NO side effects: it binds no port and registers no
 * process signal handlers. The server lifecycle (dotenv, listen, shutdown) lives
 * in index.ts. That separation is what lets tests import `createApp()` in-process.
 */
export function createApp(): Express {
  const app = express();

  app.use(express.json());

  app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/wallet", authenticate, walletRouter);

  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({
        success: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      });
    } else {
      console.error("[unhandled error]", err);
      res.status(500).json({
        success: false,
        error: { code: "UNKNOWN", message: "Something Went Wrong" },
      });
    }
  });

  return app;
}
