-- Create the house / system account: a single, well-known internal account that is the
-- counter-leg for all system-initiated money movement (the opening-balance seed now; bank
-- deposits/withdrawals in a later ticket). It is deliberately NOT a customer:
--
--   * accountType = SYSTEM  -> exempt from the customer non-negativity CHECK; it is allowed to
--     go negative, because its balance mirrors the system's float/liability to the outside world.
--   * passwordHash is an UNUSABLE sentinel -> the account can never authenticate. It is a valid
--     bcrypt (cost 12) hash of a random secret that was generated once and discarded, so
--     bcrypt.compare() runs the full constant-time work and returns false for every input
--     (no user-enumeration timing tell). Same shape as auth.service's DECOY_HASH.
--   * identity fields are reserved and non-colliding: an RFC-2606 ".invalid" email that can
--     never be a real deliverable address, and a non-numeric phoneNumber that can never collide
--     with a real (numeric) phone.
--
-- The ids are PINNED (not random) so application code can reference the account by constant
-- (HOUSE_USER_ID / HOUSE_WALLET_ID) with no runtime lookup. ON CONFLICT DO NOTHING keeps the
-- seed idempotent if the migration is ever re-applied against an already-seeded database.

-- House User: an identity shell required only by the Wallet.userId FK. It never logs in.
INSERT INTO "User" ("id", "email", "phoneNumber", "firstName", "lastName", "passwordHash", "createdAt", "updatedAt")
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'house@system.invalid',
    'SYSTEM_HOUSE_ACCOUNT',
    'System',
    'House',
    '$2b$12$fpPUwExH8HQsMdELclHwBesI9pnZB3kQ8F7Mu/eTKvDbwfIcmeunC',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;

-- House Wallet: accountType SYSTEM, so the conditional CHECK permits a negative balance.
-- Starts at 0 here; the opening-balance seed (next migration) posts the counter-legs and
-- drives the cached balance to -SUM(customer balances).
INSERT INTO "Wallet" ("id", "userId", "balance", "currency", "accountType", "createdAt", "updatedAt")
VALUES (
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    0,
    'INR',
    'SYSTEM',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;
