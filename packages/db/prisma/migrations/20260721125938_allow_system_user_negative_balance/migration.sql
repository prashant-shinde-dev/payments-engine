-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('CUSTOMER', 'SYSTEM');

-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'OPENING_BALANCE';

-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "accountType" "AccountType" NOT NULL DEFAULT 'CUSTOMER';

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LedgerEntry_walletId_idx" ON "LedgerEntry"("walletId");

-- CreateIndex
CREATE INDEX "LedgerEntry_transactionId_idx" ON "LedgerEntry"("transactionId");

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Drop the old strict non-negative check
ALTER TABLE "Wallet" DROP CONSTRAINT IF EXISTS "Wallet_balance_nonnegative";

-- Apply the new conditional bypass constraint
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_balance_nonnegative" 
CHECK ("accountType" <> 'CUSTOMER' OR "balance" >= 0);
