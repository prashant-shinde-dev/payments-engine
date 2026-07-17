import cron from "node-cron";
import { reapExpiredRecords } from "./removeExpiredKeysJob.js";

/**
 * Registers the hourly idempotency-record reaper and returns the scheduled task.
 * Importing this module has NO side effect (mirrors createApp) — the bootstrap calls
 * startReaper() explicitly, so tests and tooling can import it without starting a cron.
 * Observability rides node-cron's execution events, so an unattended run logs its
 * outcome instead of failing silently.
 */
export function startReaper() {
  const task = cron.schedule("@hourly", () => reapExpiredRecords());

  task.on("execution:finished", (ctx) => {
    console.log(
      `${ctx.triggeredAt} [reaper] removed ${ctx.execution?.result} expired idempotency records`,
    );
  });

  task.on("execution:failed", (ctx) => {
    console.error(
      `${ctx.triggeredAt}[reaper] failed to remove expired idempotency records: ${ctx.execution?.error}`,
    );
  });

  return task;
}
