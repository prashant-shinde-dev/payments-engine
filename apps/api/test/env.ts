import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Loads apps/api/.env.test and guarantees the suite can only ever talk to a test
 * database. This module is imported FIRST by both setup.ts (test workers) and
 * global-setup.ts (main process), before any code touches `@payments/db/client`
 * — which reads process.env.DATABASE_URL at construction time.
 *
 *  - The path is resolved relative to THIS file, never the cwd, so it loads the
 *    same file no matter how or from where vitest is launched.
 *  - `override: true` makes .env.test authoritative over any pre-existing env
 *    (e.g. a DATABASE_URL exported in the shell), so a stray dev value can't win.
 *  - The guard asserts the database name ends with `_test` and throws otherwise,
 *    so a missing or misconfigured file fails the run loudly instead of silently
 *    falling through to the dev database.
 */
const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../.env.test"), override: true });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Refusing to run tests without an explicit test database (apps/api/.env.test).",
  );
}

let databaseName: string;
try {
  databaseName = new URL(url).pathname.replace(/^\//, "");
} catch {
  throw new Error(`DATABASE_URL is not a valid connection string: ${url}`);
}

if (!databaseName.endsWith("_test")) {
  throw new Error(
    `Refusing to run the test suite against database "${databaseName}". ` +
      `The test database name must end with "_test".`,
  );
}

export const TEST_DATABASE_URL = url;
export const TEST_DATABASE_NAME = databaseName;
