import z from "zod";

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

export type RegisterInputs = z.infer<typeof registerSchema>;
export type PaginationInputs = z.infer<typeof paginationSchema>;
export type LoginInputs = z.infer<typeof loginSchema>;
export type TransactionInputs = z.infer<typeof transactionSchema>;
