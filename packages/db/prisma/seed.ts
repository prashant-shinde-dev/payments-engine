import "dotenv/config";
import bcrypt from "bcrypt";
import { prisma } from "../src/index.js";

// Dev seed — recreates test users, each with an auto-created wallet (mirroring the
// register flow), so a DB reset is a one-command recovery: `npm run db:seed`.
// Re-runnable: upserts by email, so running it on a populated DB is a no-op.

const PASSWORD = "Test@1234"; // dev login password for every seeded user
const SALT_ROUNDS = 12; // must match auth.service.ts so seeded users can log in

const USERS = [
  { email: "alice@example.com", phoneNumber: "+919000000001", firstName: "Alice", lastName: "Anand", balance: "1000.00" },
  { email: "bob@example.com", phoneNumber: "+919000000002", firstName: "Bob", lastName: "Banerjee", balance: "500.00" },
  { email: "carol@example.com", phoneNumber: "+919000000003", firstName: "Carol", lastName: "Chopra", balance: "0.00" },
];

async function main(): Promise<void> {
  const passwordHash = await bcrypt.hash(PASSWORD, SALT_ROUNDS);

  for (const u of USERS) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: {}, // leave an existing user (and its wallet) untouched
      create: {
        email: u.email,
        phoneNumber: u.phoneNumber,
        firstName: u.firstName,
        lastName: u.lastName,
        passwordHash,
        wallet: { create: { balance: u.balance } },
      },
      include: { wallet: true },
    });
    console.log(`✓ ${user.email}  (${user.id})  balance ${user.wallet?.balance ?? "—"}`);
  }

  console.log(`\nSeeded ${USERS.length} users — login password for all: ${PASSWORD}`);
}

main()
  .catch((e: unknown) => {
    console.error("seed failed:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
