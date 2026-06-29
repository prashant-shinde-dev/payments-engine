import express, { Request, Response } from "express";
import {
  getBalance,
  getTransactions,
  transferCore,
} from "../services/wallet.service.js";
import { runIdempotent } from "../services/idempotency.js";

import {
  idempotentKeySchema,
  paginationSchema,
  transactionSchema,
} from "@payments/zod-schemas";
import { ApiResponse } from "@payments/types";
import { validate } from "../middleware/validation.js";

export const router = express.Router();

router.get("/balance", async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const balance = await getBalance(userId);

  res
    .status(200)
    .json({ success: true, data: balance } satisfies ApiResponse<
      typeof balance
    >);
});

router.get("/transactions", async (req: Request, res: Response) => {
  const { userId } = req.user!;
  const { page, pageSize } = validate(paginationSchema, req.query);
  const transactions = await getTransactions(
    userId,
    page ? Number(page) : undefined,
    pageSize ? Number(pageSize) : undefined,
  );
  res
    .status(200)
    .json({ success: true, data: transactions } satisfies ApiResponse<
      typeof transactions
    >);
});
router.post("/transfer", async (req: Request, res: Response) => {
  const { receiver, amount } = validate(transactionSchema, req.body);
  const sender = req.user!.userId;
  const { idempotencykey } = validate(idempotentKeySchema, req.headers);
  const transaction = await runIdempotent(
    sender,
    idempotencykey,
    transferCore,
    {
      sender,
      receiver,
      amount,
    },
  );
  res
    .status(201)
    .json({ success: true, data: transaction } satisfies ApiResponse<
      typeof transaction
    >);
});
