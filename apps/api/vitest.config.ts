import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Loads .env.test + the _test guard, then registers the truncate hook. Runs
    // inside each test worker so process.env is set before tests read it.
    setupFiles: ["./test/setup.ts"],
    // Runs once in the main process: create + migrate the test database.
    globalSetup: ["./test/global-setup.ts"],
    // One shared database — files must not run in parallel or they'd truncate
    // each other's data mid-test. (Concurrency WITHIN a test is the point of the
    // concurrency suite and is unaffected by this.)
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 20_000,
  },
});
