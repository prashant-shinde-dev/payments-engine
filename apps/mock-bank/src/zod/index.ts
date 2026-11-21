import z from "zod";
import validator from "validator";

export const transferSchema = z.object({
  amount: z
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
    ),
  pspReferenceId: z.uuid(),
  currency: z
    .string()
    .refine((val) => validator.isISO4217(val), { message: `Invalid Currency` }),
});

export const referenceIdSchema = z.object({
  pspReferenceId: z.uuid(),
});

export type TransferInputs = z.infer<typeof transferSchema>;
export type PspReferenceId = z.infer<typeof referenceIdSchema>;
