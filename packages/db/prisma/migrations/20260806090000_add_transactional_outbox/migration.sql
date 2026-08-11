-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

-- CreateTable
CREATE TABLE "TransactionOutbox" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "status" "TransactionStatus" NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "userId" TEXT NOT NULL,
    "publishStatus" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyJobRecord" (
    "eventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyJobRecord_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "TransactionOutbox_transactionId_key" ON "TransactionOutbox"("transactionId");

-- CreateIndex
-- The relay's claim: WHERE "publishStatus" = 'PENDING' ORDER BY "createdAt".
-- "nextAttemptAt" is deliberately not in the index — it filters out a handful of
-- backing-off rows, while "createdAt" has to serve the ORDER BY.
CREATE INDEX "TransactionOutbox_publishStatus_createdAt_idx" ON "TransactionOutbox"("publishStatus", "createdAt");
