-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "userId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "response" TEXT,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("userId","idempotencyKey")
);
