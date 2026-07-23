-- Enforce D6 (append-only ledger) at the database level: a posted LedgerEntry can never be
-- updated or deleted. Corrections are expressed as NEW, balanced legs — never by mutating history.
--
-- Why a TRIGGER and not REVOKE UPDATE, DELETE:
--   REVOKE is bypassed by the table owner and by superusers — PostgreSQL does not consult the
--   grant table for them at all. This application connects as `admin`, which is the database
--   owner/superuser (POSTGRES_USER), so a REVOKE would apply cleanly, change nothing, and give a
--   false sense of security. A trigger is part of the table's behavior, not its privilege set, so
--   it fires for EVERYONE — app, owner, superuser, ORM, or a hand-typed psql session. Nothing
--   short of an explicit, auditable `ALTER TABLE ... DISABLE TRIGGER` can bypass it.
--
-- Scope: INSERT is intentionally NOT guarded — appends are how the ledger grows. Only UPDATE and
-- DELETE are refused, which is what makes the table append-only rather than merely read-only.

CREATE OR REPLACE FUNCTION "ledger_entry_is_immutable"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'LedgerEntry is append-only: % is not permitted (row id: %). Post a new balanced entry to correct.',
        TG_OP, OLD."id";
END;
$$ LANGUAGE plpgsql;

-- DROP-then-CREATE so a manual re-run of this file is a clean no-op rather than an
-- "already exists" error (CREATE TRIGGER, unlike CREATE OR REPLACE FUNCTION, is not idempotent).
DROP TRIGGER IF EXISTS "ledger_entry_no_update_delete" ON "LedgerEntry";
CREATE TRIGGER "ledger_entry_no_update_delete"
    BEFORE UPDATE OR DELETE ON "LedgerEntry"
    FOR EACH ROW EXECUTE FUNCTION "ledger_entry_is_immutable"();
