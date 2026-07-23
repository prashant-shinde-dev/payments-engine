-- Seed opening balances into the double-entry ledger (Option A: every movement is balanced).
--
-- For each CUSTOMER wallet with a non-zero balance, record its existing balance as a real,
-- two-leg OPENING_BALANCE movement (house -> customer):
--     customer leg:  +balance
--     house leg:     -balance
-- so that SUM(legs) == wallet.balance for every wallet from the very first read, and the house
-- wallet ends at -SUM(customer balances) — its float / liability mirror.
--
-- Design notes:
--   * wallet.balance is UNCHANGED for customers; it simply becomes the cache of these legs.
--   * Zero-balance wallets are skipped: the SUM of no legs is already 0, so they are consistent.
--   * ids are generated with gen_random_uuid() (built-in on PostgreSQL 13+; this project runs 15).
--   * OPENING_BALANCE was added via ALTER TYPE ADD VALUE in an EARLIER, committed migration, so it
--     is safe to use here (it must never share a transaction with the ADD VALUE).
--   * Parent (Transaction) and children (LedgerEntry) are inserted in SEPARATE statements. A single
--     WITH cannot be used: its sub-statements share one snapshot and cannot see one another's
--     writes, so the legs' FK to Transaction would not find the just-inserted parent rows. Separate
--     statements in the same transaction DO see prior statements' effects, so the FK is satisfied.
--   * The NOT EXISTS guards make the whole migration idempotent (safe to re-run / after a reset).

-- 1. One OPENING_BALANCE Transaction per eligible customer wallet (house -> customer).
INSERT INTO "Transaction" ("id", "fromUserId", "toUserId", "amount", "type", "status", "note", "createdAt")
SELECT
    gen_random_uuid()::text,
    '00000000-0000-0000-0000-000000000001',   -- house user (from)
    w."userId",                               -- customer user (to)
    w."balance",
    'OPENING_BALANCE',
    'SUCCESS',
    'Opening balance migrated to double-entry ledger',
    CURRENT_TIMESTAMP
FROM "Wallet" w
WHERE w."accountType" = 'CUSTOMER'
  AND w."balance" <> 0
  AND NOT EXISTS (
      SELECT 1 FROM "Transaction" t
      WHERE t."type" = 'OPENING_BALANCE' AND t."toUserId" = w."userId"
  );

-- 2. The two balanced legs for every opening-balance movement that has none yet.
INSERT INTO "LedgerEntry" ("id", "walletId", "transactionId", "amount", "createdAt")
    -- customer leg: +balance
    SELECT gen_random_uuid()::text, cw."id", t."id", t."amount", CURRENT_TIMESTAMP
    FROM "Transaction" t
    JOIN "Wallet" cw ON cw."userId" = t."toUserId"
    WHERE t."type" = 'OPENING_BALANCE'
      AND NOT EXISTS (SELECT 1 FROM "LedgerEntry" le WHERE le."transactionId" = t."id")
    UNION ALL
    -- house leg: -balance
    SELECT gen_random_uuid()::text, '00000000-0000-0000-0000-000000000002', t."id", -t."amount", CURRENT_TIMESTAMP
    FROM "Transaction" t
    WHERE t."type" = 'OPENING_BALANCE'
      AND NOT EXISTS (SELECT 1 FROM "LedgerEntry" le WHERE le."transactionId" = t."id");

-- 3. Set the house cached balance to -SUM(all customer balances); its legs sum to the same value.
UPDATE "Wallet"
SET "balance" = -(SELECT COALESCE(SUM("balance"), 0) FROM "Wallet" WHERE "accountType" = 'CUSTOMER'),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = '00000000-0000-0000-0000-000000000002';

-- 4. Safety belt: every balanced movement sums to zero, so the sum of ALL ledger legs must be
--    exactly zero. Fail the migration loudly if the seed math is wrong, rather than leaving a
--    silently broken ledger (deleting/writing money-adjacent data earns a stronger guard).
DO $$
DECLARE total NUMERIC;
BEGIN
    SELECT COALESCE(SUM("amount"), 0) INTO total FROM "LedgerEntry";
    IF total <> 0 THEN
        RAISE EXCEPTION 'Ledger conservation violated after opening-balance seed: SUM(legs) = %', total;
    END IF;
END $$;
