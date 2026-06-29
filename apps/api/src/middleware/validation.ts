import { z } from "zod";
import { ValidationError } from "../errors/index.js";

export function validate<T extends z.ZodType>(
  schema: T,
  inputBody: unknown,
): z.infer<T> {
  const result = schema.safeParse(inputBody);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.join(".") || "(root)",
      message: issue.message,
    }));
    throw new ValidationError("Invalid request input", details);
  }
  return result.data;
}
