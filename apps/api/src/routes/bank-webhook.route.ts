import express, { Request, Response } from "express";
import { validate } from "../middleware/validation.js";
import { bankTransferWebhookCallbackSchema } from "@payments/zod-schemas";
import { settleBankTransfer } from "../services/bank-webhook.service.js";
import { verifyBankSignature } from "../bank/signature.js";
export const router = express.Router();

router.post(
  "/payment",
  verifyBankSignature,
  async (req: Request, res: Response) => {
    const data = validate(bankTransferWebhookCallbackSchema, req.body);
    // 2xx means "durably recorded", never "agreed with" — a dispute is recorded and acknowledged,
    // and only a genuine failure to record reaches the error middleware as a 5xx (ADR-018).
    await settleBankTransfer(data);
    res.status(200).json({ msg: "RECEIVED" });
  },
);
