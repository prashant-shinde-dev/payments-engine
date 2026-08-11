-- Wake the outbox relay the moment an outbox row commits, rather than leaving it to the
-- relay's fallback poll. The relay holds a dedicated LISTEN connection on the
-- `outbox_notification` channel (apps/api/src/relay.ts); this trigger is what signals it.
--
-- Why a TRIGGER and not a pg_notify() call in the producer:
--   The signal becomes a property of the table instead of a property of one call site. Every
--   path that inserts an outbox row — the transfer service today, a backfill or a hand-typed
--   psql session tomorrow — signals without having to remember to, and the producer stays
--   ignorant that a relay exists at all.
--
-- Why this is NOT the dual-write the outbox itself exists to prevent:
--   Two independent reasons, either one sufficient.
--   1. NOTIFY is part of THIS transaction. It is queued while the transaction runs, delivered
--      only on COMMIT, and discarded on ROLLBACK. One store, one commit — unlike an enqueue to
--      Redis, which cannot participate in a Postgres commit at all.
--   2. The notification carries no payload and no work. It means "the outbox changed, go look",
--      never "here is a row". The relay re-reads committed rows and only ever UPDATEs rows that
--      already exist, so a spurious notification costs one empty drain and a lost one costs
--      nothing — the row stays PENDING and the fallback poll sweeps it up. Delivery is
--      best-effort by design, which is why that poll is not optional.
--
-- Why FOR EACH STATEMENT and not FOR EACH ROW:
--   The function reads neither NEW nor OLD, so what it reports is a statement-level fact.
--   PostgreSQL collapses duplicate notifications (same channel, same payload) within a
--   transaction, so both levels deliver exactly one notification per committed transaction;
--   FOR EACH ROW would only invoke the function once per inserted row to arrive at that same
--   single delivery. STATEMENT additionally makes NEW unavailable, so the payload cannot grow
--   row data later without a deliberate change of trigger level.
--
-- Scope: INSERT only. The relay marks rows PUBLISHED with an UPDATE, so notifying on UPDATE
-- would wake the relay with its own writes, to find nothing. A row leaving its poison backoff
-- has no statement to fire on at all — one more reason the fallback poll stays.
--
-- The channel name must match the relay's `LISTEN outbox_notification` exactly. Both are
-- written unquoted: PostgreSQL folds unquoted identifiers to lowercase, so quoting it here
-- would match only by coincidence, and any later rename introducing a capital would split the
-- two into different channels with no error on either side.

CREATE OR REPLACE FUNCTION "transaction_outbox_notify"() RETURNS trigger AS $$
BEGIN
    NOTIFY outbox_notification;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- DROP-then-CREATE so a manual re-run of this file is a clean no-op rather than an
-- "already exists" error (CREATE TRIGGER, unlike CREATE OR REPLACE FUNCTION, is not idempotent).
DROP TRIGGER IF EXISTS "transaction_outbox_notify_on_insert" ON "TransactionOutbox";
CREATE TRIGGER "transaction_outbox_notify_on_insert"
    AFTER INSERT ON "TransactionOutbox"
    FOR EACH STATEMENT EXECUTE FUNCTION "transaction_outbox_notify"();
