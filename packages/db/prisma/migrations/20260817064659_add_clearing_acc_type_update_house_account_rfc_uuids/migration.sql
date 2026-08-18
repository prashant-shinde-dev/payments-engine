-- Add Clearing Account Type
ALTER TYPE "AccountType" ADD VALUE IF NOT EXISTS 'CLEARING';

-- User first. Cascades to Wallet.userId and Transaction columns.
-- Touches no LedgerEntry row, so the append-only trigger is not involved.
UPDATE "User" SET "id" = '00000000-0000-4000-8000-000000000001'
WHERE "id" = '00000000-0000-0000-0000-000000000001';

-- Wallet second. This one DOES cascade into LedgerEntry.walletId,
-- which the append-only trigger refuses. Narrow the window to one statement.
ALTER TABLE "LedgerEntry" DISABLE TRIGGER "ledger_entry_no_update_delete";

UPDATE "Wallet" SET "id" = '00000000-0000-4000-8000-000000000002'
WHERE "id" = '00000000-0000-0000-0000-000000000002';

ALTER TABLE "LedgerEntry" ENABLE TRIGGER "ledger_entry_no_update_delete";