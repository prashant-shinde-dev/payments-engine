-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RejectionReason" AS ENUM ('INSUFFICIENT_FUNDS', 'ACCOUNT_CLOSED', 'ACCOUNT_NOT_FOUND', 'INVALID_ACCOUNT', 'ACCOUNT_BLOCKED', 'LIMIT_EXCEEDED', 'CURRENCY_NOT_SUPPORTED');

-- CreateEnum
CREATE TYPE "Status" AS ENUM ('RECEIVED', 'REJECTED', 'SETTLED');

-- CreateEnum
CREATE TYPE "Type" AS ENUM ('TRANSFER', 'RETURN');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'UNDELIVERABLE', 'EXHAUSTED');

-- CreateTable
CREATE TABLE "TransferRequest" (
    "id" TEXT NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "pspReferenceId" TEXT NOT NULL,
    "status" "Status" NOT NULL DEFAULT 'RECEIVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currency" TEXT NOT NULL DEFAULT 'INR',

    CONSTRAINT "TransferRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionEvent" (
    "eventId" TEXT NOT NULL,
    "trackingId" TEXT NOT NULL,
    "pspReferenceId" TEXT NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "type" "Type" NOT NULL DEFAULT 'TRANSFER',
    "status" "Status" NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "rejectionReason" "RejectionReason",
    "originalTrackingId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveryStatus" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttempt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,

    CONSTRAINT "TransactionEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "TransferRequest_pspReferenceId_key" ON "TransferRequest"("pspReferenceId");

-- CreateIndex
CREATE INDEX "TransactionEvent_nextAttempt_idx" ON "TransactionEvent"("nextAttempt");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionEvent_trackingId_status_key" ON "TransactionEvent"("trackingId", "status");
