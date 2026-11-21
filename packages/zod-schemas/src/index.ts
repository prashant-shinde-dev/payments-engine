import z from "zod";
import validator from "validator";

function checkOutcomeFields(data: OutcomeFields, ctx: z.RefinementCtx) {
  if (data.type === "RETURN" && data.originalTrackingId === null) {
    ctx.addIssue({
      code: "custom",
      message: "originalTrackingId is required when type is 'RETURN'",
      path: ["originalTrackingId"],
    });
  }
  if (data.status === "REJECTED" && data.rejectionReason === null) {
    ctx.addIssue({
      code: "custom",
      message: "rejectionReason is required when status is 'REJECTED'",
      path: ["rejectionReason"],
    });
  }
  if (data.status !== "REJECTED" && data.rejectionReason !== null) {
    ctx.addIssue({
      code: "custom",
      message: "rejectionReason is only valid when status is 'REJECTED'",
      path: ["rejectionReason"],
    });
  }
}

const isoTimestamp = z.iso.datetime({
  message: "Invalid ISO 8601 UTC timestamp",
});

const amountSchema = z
  .string()
  .regex(/^(?:[1-9]\d{0,17}|(?:[1-9]\d{0,17}|0)\.\d{1,2})$/, {
    message: "please provide a valid amount",
  })
  .refine(
    (val) => {
      if (val === "0.00" || val === "0.0") {
        return false;
      }
      return true;
    },
    { message: "the transfer amount cant be zero" },
  );
export const registerSchema = z.object({
  firstName: z
    .string()
    .min(1, "first name is required")
    .max(50, "first name cant be more than 50 characters"),
  lastName: z
    .string()
    .min(1, "last name is required")
    .max(50, "last name cant be more than 50 characters"),
  phoneNumber: z.e164(),
  email: z.email(),
  password: z
    .string()
    .min(8, "password should be min of 8 characters")
    .max(16, "password should be max of 16 characters")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[0-9]/, "Password must contain at least one number"),
});

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1, "please provide password"),
});

export const transactionSchema = z.object({
  receiver: z.uuid(),
  amount: amountSchema,
});

export const paginationSchema = z.object({
  page: z
    .string()
    .regex(/^[1-9]\d*$/, { message: "the page number is invalid" })
    .optional(),
  pageSize: z
    .string()
    .regex(/^[1-9]\d*$/, { message: "the page size is invalid" })
    .optional(),
});

export const idempotentKeySchema = z.object({
  idempotencykey: z.uuid(),
});

export const bankTransferSchema = z.object({
  amount: amountSchema,
  direction: z.enum(["deposit", "withdrawal"]),
});

export const bankTransferQueuePayloadSchema = z.object({
  id: z.uuid(),
  transactionId: z.uuid(),
  type: z.enum(["BANK_DEPOSIT", "BANK_WITHDRAWAL"]),
  userId: z.uuid(),
  amount: amountSchema,
});

const bankTransferStatusSchema = z.enum(["RECEIVED", "REJECTED", "SETTLED"]);

const rejectionReasonSchema = z.enum([
  "INSUFFICIENT_FUNDS",
  "ACCOUNT_CLOSED",
  "ACCOUNT_NOT_FOUND",
  "INVALID_ACCOUNT",
  "ACCOUNT_BLOCKED",
  "LIMIT_EXCEEDED",
  "CURRENCY_NOT_SUPPORTED",
]);

export const bankResponseSchema = z.object({
  trackingId: z.uuid(),
  pspReferenceId: z.uuid(),
  status: bankTransferStatusSchema,
  receivedAt: isoTimestamp,
});

const bankTransferRecordSchema = z.object({
  trackingId: z.uuid(),
  pspReferenceId: z.uuid(),
  amount: amountSchema,
  status: bankTransferStatusSchema,
  currency: z.string().refine((val) => validator.isISO4217(val), {
    message: "unsupported currency",
  }),
  type: z.enum(["TRANSFER", "RETURN"]),
  // null on every non-rejection; the superRefine below ties it to the status.
  rejectionReason: rejectionReasonSchema.nullable(),
  originalTrackingId: z.uuid().nullable(),
  receivedAt: isoTimestamp,
});

export const bankTransferWebhookCallbackSchema = bankTransferRecordSchema
  .extend({
    eventId: z.uuid(),
    settledAt: isoTimestamp,
  })
  .superRefine((data, ctx) => {
    checkOutcomeFields(data, ctx);
  });

export type RegisterInputs = z.infer<typeof registerSchema>;
export type PaginationInputs = z.infer<typeof paginationSchema>;
export type LoginInputs = z.infer<typeof loginSchema>;
export type TransactionInputs = z.infer<typeof transactionSchema>;
export type BankTransferInputs = z.infer<typeof bankTransferSchema>;
export type BankTransferQueuePayloadInputs = z.infer<
  typeof bankTransferQueuePayloadSchema
>;
export type BankResponse = z.infer<typeof bankResponseSchema>;
export type BankTransferWebhookCallbackInputs = z.infer<
  typeof bankTransferWebhookCallbackSchema
>;
type BankTransferRecord = z.infer<typeof bankTransferRecordSchema>;
type OutcomeFields = Pick<
  BankTransferRecord,
  "originalTrackingId" | "rejectionReason" | "status" | "type"
>;
