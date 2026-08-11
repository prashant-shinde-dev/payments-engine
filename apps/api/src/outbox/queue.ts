import { AppError } from "../errors/index.js";

export const BANK_TRANSFER_QUEUE = "bank-transfer";

export function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new AppError("CONFIG_MISSING", "REDIS_URL is not set", 500);
  }
  return url;
}
