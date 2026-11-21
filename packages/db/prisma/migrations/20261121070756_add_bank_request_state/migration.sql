-- CreateEnum
CREATE TYPE "BankRequestStatus" AS ENUM ('SUBMITTING', 'SUBMITTED', 'HALTED');

-- DropTable
DROP TABLE "IdempotencyJobRecord";

-- CreateTable
CREATE TABLE "BankRequest" (
    "eventId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "status" "BankRequestStatus" NOT NULL DEFAULT 'SUBMITTING',
    "bankReference" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankRequest_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "BankRequest_transactionId_key" ON "BankRequest"("transactionId");
