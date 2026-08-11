import { Redis } from "ioredis";

const PRODUCER_COMMAND_TIMEOUT_MS = 5_000;
const PRODUCER_MAX_RETRIES_PER_REQUEST = 3;

export function producerRedis(url: string): Redis {
  return new Redis(url, {
    commandTimeout: PRODUCER_COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: PRODUCER_MAX_RETRIES_PER_REQUEST,
  });
}

export function consumerRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}
