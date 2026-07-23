// MUST be first: loads .env.test + runs the _test guard before the Prisma client
// (imported just below) reads DATABASE_URL at construction time.
import "./env.js";
import { afterAll, beforeEach } from "vitest";
import { HOUSE_USER_ID, HOUSE_WALLET_ID, prisma } from "@payments/db/client";

/**
 * Per-test isolation. Every test builds its own world through helpers; this wipes
 * that world before the next test so the suite is order-independent and passes
 * repeatedly with no manual cleanup. CASCADE clears FK-linked rows in one pass.
 */
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "User", "Wallet", "Transaction", "IdempotencyRecord" CASCADE',
  );
  // Re-seed the house account that TRUNCATE removes; every test needs it back.
  await prisma.user.create({
    data: {
      id: HOUSE_USER_ID,
      email: "house@system.invalid",
      phoneNumber: "SYSTEM_HOUSE_ACCOUNT",
      firstName: "System",
      lastName: "House",
      // Locked sentinel — bcrypt of a discarded secret; never authenticates.
      passwordHash: "$2b$12$fpPUwExH8HQsMdELclHwBesI9pnZB3kQ8F7Mu/eTKvDbwfIcmeunC",
    },
  });
  await prisma.wallet.create({
    data: {
      id: HOUSE_WALLET_ID,
      userId: HOUSE_USER_ID,
      balance: "0",
      currency: "INR",
      accountType: "SYSTEM",
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
