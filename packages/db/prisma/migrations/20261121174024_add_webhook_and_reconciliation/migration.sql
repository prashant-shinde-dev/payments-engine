-- CreateEnum
CREATE TYPE "ReconciliationEventType" AS ENUM ('SETTLEMENT', 'RETURN');

-- CreateEnum
CREATE TYPE "DisputeReason" AS ENUM ('AMOUNT_MISMATCH', 'UNKNOWN_REFERENCE', 'STATE_MISMATCH');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('PENDING', 'COMPLETED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "FailureReason" AS ENUM ('INSUFFICIENT_FUNDS', 'ACCOUNT_CLOSED', 'ACCOUNT_NOT_FOUND', 'INVALID_ACCOUNT', 'ACCOUNT_BLOCKED', 'LIMIT_EXCEEDED', 'CURRENCY_NOT_SUPPORTED');

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "eventId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "response" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "ReconciliationRecord" (
    "id" TEXT NOT NULL,
    "providerReferenceId" TEXT NOT NULL,
    "transactionId" TEXT,
    "originalReferenceId" TEXT,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "rawStatus" TEXT NOT NULL,
    "type" "ReconciliationEventType" NOT NULL,
    "rawType" TEXT NOT NULL,
    "failureReason" "FailureReason",
    "rawFailureReason" TEXT,
    "amount" DECIMAL(20,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "providerReceivedAt" TIMESTAMP(3),
    "providerSettledAt" TIMESTAMP(3),
    "reconciliationStatus" "ReconciliationStatus" NOT NULL DEFAULT 'PENDING',
    "disputeReason" "DisputeReason",
    "providerEventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconciliationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookEvent_createdAt_idx" ON "WebhookEvent"("createdAt");

-- CreateIndex
CREATE INDEX "ReconciliationRecord_reconciliationStatus_createdAt_idx" ON "ReconciliationRecord"("reconciliationStatus", "createdAt");

-- CreateIndex
CREATE INDEX "ReconciliationRecord_transactionId_idx" ON "ReconciliationRecord"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationRecord_providerReferenceId_key" ON "ReconciliationRecord"("providerReferenceId");

-- AddForeignKey
ALTER TABLE "ReconciliationRecord" ADD CONSTRAINT "ReconciliationRecord_providerEventId_fkey" FOREIGN KEY ("providerEventId") REFERENCES "WebhookEvent"("eventId") ON DELETE RESTRICT ON UPDATE CASCADE;
