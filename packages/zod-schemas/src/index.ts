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

export type RegisterInputs = z.infer<typeof registerSchema>;

export type LoginInputs = z.infer<typeof loginSchema>;
