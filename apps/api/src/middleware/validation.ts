import { z } from "zod";
import { ValidationError } from "../errors/index.js";

export function validate<T extends z.ZodType>(
  schema: T,
  inputBody: unknown,
): z.infer<T> {
  const response = schema.safeParse(inputBody);
  if (!response.success) {
    throw new ValidationError(response.error.message);
  }
  return response.data;
}
