import express, { type Request, type Response } from "express";
import {
  referenceIdSchema,
  transferSchema,
  type TransferInputs,
} from "../zod/index.js";
import { ValidationError } from "../errors/index.js";
import {
  getTransaction,
  logTransferRequest,
} from "../services/transfer.service.js";
import { verifySignature } from "../services/authenticate.js";

export const router = express.Router();

router.post(
  "/transfer",
  verifySignature,
  async (req: Request, res: Response) => {
    const response = transferSchema.safeParse(req.body);
    if (!response.success) {
      throw new ValidationError(response.error.message);
    }
    const data: TransferInputs = response.data;

    const { id, pspReferenceId, status, createdAt } =
      await logTransferRequest(data);
    res.status(202).json({
      trackingId: id,
      pspReferenceId,
      status,
      receivedAt: createdAt,
    });
  },
);

router.get(
  "/transfer/:pspReferenceId",
  verifySignature,
  async (req: Request, res: Response) => {
    const response = referenceIdSchema.safeParse(req.params);
    if (!response.success) {
      throw new ValidationError(response.error.message);
    }
    const { pspReferenceId } = response.data;
    const transaction = await getTransaction(pspReferenceId);
    res.status(200).json(transaction);
  },
);
