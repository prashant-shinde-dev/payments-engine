// MUST be first: loads .env.test + runs the _test guard before the Prisma client
// (imported just below) reads DATABASE_URL at construction time.
import "./env.js";
import { afterAll, beforeEach } from "vitest";
import { prisma } from "@payments/db/client";

/**
 * Per-test isolation. Every test builds its own world through helpers; this wipes
 * that world before the next test so the suite is order-independent and passes
 * repeatedly with no manual cleanup. CASCADE clears FK-linked rows in one pass.
 */
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "User", "Wallet", "Transaction", "IdempotencyRecord" CASCADE',
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});
