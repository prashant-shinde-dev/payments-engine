import express, { Request, Response } from "express";
import {
  getBalance,
  getTransactions,
  send,
} from "../services/wallet.service.js";

import { paginationSchema, transactionSchema } from "@payments/zod-schemas";
import { ValidationError } from "../errors/index.js";
import { ApiResponse } from "@payments/types";

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
  const response = paginationSchema.safeParse(req.query);
  if (!response.success) {
    throw new ValidationError(response.error.message);
  }

  const { page, pageSize } = response.data;

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
  const response = transactionSchema.safeParse(req.body);
  if (!response.success) {
    throw new ValidationError(response.error.message);
  }
  const { receiver, amount } = response.data;

  const sender = req.user!.userId;

  const transaction = await send({ sender, receiver, amount });
  res
    .status(201)
    .json({ success: true, data: transaction } satisfies ApiResponse<
      typeof transaction
    >);
});
