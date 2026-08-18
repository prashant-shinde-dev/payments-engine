INSERT INTO "User" ("id", "email", "phoneNumber", "firstName", "lastName", "passwordHash", "createdAt", "updatedAt") VALUES (
  '00000000-0000-4000-8000-000000000003',
  'clearing@system.invalid', 'SYSTEM_CLEARING_ACCOUNT', 'System', 'Clearing',
  '$2b$12$fpPUwExH8HQsMdELclHwBesI9pnZB3kQ8F7Mu/eTKvDbwfIcmeunC', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
) ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Wallet" ("id", "userId", "balance", "currency", "accountType", "createdAt", "updatedAt") VALUES (
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000003',
  0, 'INR', 'CLEARING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
) ON CONFLICT ("id") DO NOTHING;

-- update check constraint
ALTER TABLE "Wallet" DROP CONSTRAINT IF EXISTS "Wallet_balance_nonnegative";
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_balance_nonnegative"
  CHECK ("accountType" = 'SYSTEM' OR "balance" >= 0);