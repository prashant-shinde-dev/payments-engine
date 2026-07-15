// MUST be first: loads .env.test + runs the _test guard before we create or
// migrate anything.
import "./env.js";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const dbPackageDir = resolve(here, "../../../packages/db");

/**
 * Runs ONCE before the whole suite (vitest globalSetup, main process). Owns the
 * test database's lifecycle so a fresh clone needs nothing by hand beyond a
 * running Postgres: it creates payments_system_test if absent, then applies the
 * committed migrations. Both steps are safe to run when they've already run,
 * which is what lets the suite pass twice back-to-back.
 */
export default async function globalSetup(): Promise<void> {
  await ensureDatabaseExists();
  runMigrations();
}

async function ensureDatabaseExists(): Promise<void> {
  const url = new URL(process.env.DATABASE_URL!);
  const databaseName = url.pathname.replace(/^\//, "");

  // CREATE DATABASE can't run against the database being created, so connect to
  // the "postgres" maintenance database on the same server.
  url.pathname = "/postgres";
  url.search = "";

  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${databaseName}"`);
  } catch (e) {
    // 42P04 = duplicate_database: already exists, the happy path on re-runs.
    if (!isDuplicateDatabaseError(e)) throw e;
  } finally {
    await client.end();
  }
}

function runMigrations(): void {
  // Applies the same committed migrations the dev/prod database runs, so the
  // CHECK and UNIQUE constraints the concurrency/idempotency guarantees rely on
  // are present. DATABASE_URL (the _test URL) is inherited by the child.
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: dbPackageDir,
    env: process.env,
    stdio: "inherit",
  });
}

function isDuplicateDatabaseError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code: unknown }).code === "42P04"
  );
}
