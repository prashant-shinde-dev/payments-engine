import { setTimeout } from "timers/promises";
import { AppError } from "./errors/index.js";
import { prisma } from "../lib/prisma.js";

// A failing step is usually the database: retrying at idle pace would only add load to it.
const ERROR_BACKOFF_MS = 5_000;

export interface Loop {
  stop(): Promise<void>;
}

// An abort is how stop() wakes the loop, not a failure — so it ends the sleep quietly.
async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await setTimeout(ms, undefined, { signal });
  } catch (error: unknown) {
    if (!signal.aborted) throw error;
  }
}

/**
 * Runs `step` until stopped: again at once after a full batch, after `idleMs` otherwise, after a
 * longer backoff on failure. stop() lets the batch in flight finish — cutting it would leave a sent
 * callback unrecorded and redelivered once its lease expires.
 */
export function startLoop(
  name: string,
  step: () => Promise<boolean>,
  idleMs: number,
): Loop {
  const controller = new AbortController();
  const { signal } = controller;

  async function run(): Promise<void> {
    while (!signal.aborted) {
      try {
        const full = await step();
        if (!full) await sleep(idleMs, signal);
      } catch (error: unknown) {
        console.error(
          new AppError("LOOP_STEP_FAILED", `${name} step failed`, 500, error),
        );
        await sleep(ERROR_BACKOFF_MS, signal);
      }
    }
  }

  const running = run();
  return {
    stop: async (): Promise<void> => {
      controller.abort();
      await running;
    },
  };
}

export async function runWorker(
  name: string,
  step: () => Promise<boolean>,
  idleMs: number,
): Promise<void> {
  const loop = startLoop(name, step, idleMs);

  const stop = async () => {
    await loop.stop();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
