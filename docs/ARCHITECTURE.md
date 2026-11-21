# Architecture

> This document describes the system as it currently exists.
> It is rewritten as the system evolves — not appended to.
> At any point it reads as a coherent whole, not a changelog.
> Last updated: asynchronous bank settlement

---

## System Overview

A payments engine that enables users to move money in two ways:

- **P2P transfers** — send money directly to another user, settled immediately
- **Bank operations** — add funds from a bank or withdraw to one, settled asynchronously by the bank

The second is the harder one: money leaves the engine's control, the bank answers later — possibly
twice, out of order, or not at all — and the ledger has to stay provably correct throughout.

---

## High Level Design

```
┌─────────────────────────────────┐
│         Client (Next.js)        │
└────────────────┬────────────────┘
                 │ HTTPS
┌────────────────▼────────────────┐                    ┌───────────────────────────┐
│       API Server (Express)      │◄── signed callback ┤   Mock bank (apps/mock-   │
│                                 │    POST /webhook   │   bank) — its own process │
│  Auth Middleware (JWT)          │                    │   and its own database    │
│  Input Validation (Zod)         │                    │                           │
│                                 │                    │  POST /transfer  (submit) │
│  /auth/*    → AuthService       │                    │  GET  /transfer/{ref}     │
│  /wallet/*  → WalletService     │                    │  processor: settles       │
│  /webhook/* → BankWebhookService│                    │  notifier:  delivers      │
└────────────────┬────────────────┘                    └─────────────▲─────────────┘
                 │ ONE transaction: ledger legs + outbox row          │ signed submit
┌────────────────▼──────────────────────────────────┐                 │
│                    PostgreSQL                     │                 │
│  Users · Wallets · LedgerEntry · Transactions     │                 │
│  IdempotencyRecord · TransactionOutbox            │                 │
│  BankRequest · WebhookEvent · ReconciliationRecord│                 │
└───────┬───────────────────────────────▲───────────┘                 │
        │ LISTEN/NOTIFY + claim          │ request state               │
┌───────▼─────────┐   BullMQ   ┌─────────┴───────┐                    │
│  Outbox Relay   ├───────────►│  Bank  Worker   ├────────────────────┘
│  (publisher)    │   Redis    │  (consumer)     │
└─────────────────┘            └─────────────────┘
```

The request path writes to **one** store. Everything crossing into a second store (Redis) happens out
of band, in the relay (ADR-013). The worker submits to the bank and records only that the bank
accepted; the outcome arrives later as a signed callback, which is the only thing that settles money
(ADR-020). The relay and worker are separate processes, not threads of the API.

The bank is specified by [`docs/bank-api-contract.md`](bank-api-contract.md). `apps/mock-bank` is its
reference implementation and the engine's test counterpart, not a product.

---

## Data Model

```
User ──1:1──► Wallet
User ──1:N──► Transaction  (as sender)
User ──1:N──► Transaction  (as receiver)
Wallet ──1:N──► LedgerEntry       (its signed legs; balance = SUM(legs))
Transaction ──1:N──► LedgerEntry  (the balanced legs of every movement it went through)
Transaction ──1:1──► TransactionOutbox  (the async work that movement owes)
Transaction ──1:1──► BankRequest        (the instruction sent to the bank, and how far it got)
WebhookEvent ──1:N──► ReconciliationRecord  (the bank's callbacks, and what they matched)
```

### Schema

```prisma
model Wallet {
  id          String      @id @default(uuid())
  userId      String      @unique
  balance     Decimal     @db.Decimal(20, 2)  // cached projection of SUM(ledger legs)
  currency    String      @default("INR")
  accountType AccountType @default(CUSTOMER)   // CUSTOMER | SYSTEM (the house) | CLEARING
  ...
}

model LedgerEntry {            // append-only; a wallet's balance = SUM(amount)
  id            String   @id @default(uuid())
  walletId      String
  transactionId String                        // groups the legs of one transaction
  amount        Decimal  @db.Decimal(20, 2)   // signed: debit −, credit +
  createdAt     DateTime @default(now())
}

model Transaction {            // the customer's intent: house ↔ customer, never the clearing account
  id         String            @id @default(uuid())   // also the key the bank dedups on (ADR-017)
  fromUserId String
  toUserId   String
  amount     Decimal           @db.Decimal(20, 2)
  type       TransactionType   // P2P_TRANSFER | BANK_DEPOSIT | BANK_WITHDRAWAL | OPENING_BALANCE
  status     TransactionStatus // PENDING | SUCCESS | FAILED
  ...
}

model IdempotencyRecord {      // request-level dedup: one claim per (user, key)
  userId         String
  idempotencyKey String
  requestHash    String        // sha256 of the request — detects key reuse
  response       String?       // the original result, replayed on a duplicate
  @@id([userId, idempotencyKey])
}

model TransactionOutbox {      // written INSIDE the transfer's transaction
  id            String       @id @default(uuid())  // the event identity the worker dedups on
  transactionId String       @unique               // 1:1 with the movement (ADR-014)
  publishStatus OutboxStatus @default(PENDING)     // PENDING → PUBLISHED | FAILED
  attempts      Int          @default(0)
  nextAttemptAt DateTime     @default(now())       // backoff gate: a failing row steps aside
  ...
}

model BankRequest {            // committed BEFORE the bank is called
  eventId       String            @id              // the outbox row id
  transactionId String            @unique
  status        BankRequestStatus                  // SUBMITTING → SUBMITTED | HALTED
  bankReference String?                            // the bank's trackingId, once accepted
  lastError     String?
}

model WebhookEvent {           // inbound dedup + evidence
  eventId     String  @id     // the bank's delivery id
  requestHash String          // same id, different body → refused
  payload     Json            // verbatim, as received
  response    String?         // the outcome recorded for this delivery
}

model ReconciliationRecord {   // one per bank transfer record: current matching state
  providerReferenceId  String  @unique   // the bank's trackingId
  transactionId        String?           // nullable: an unknown reference is still storable
  status               TransactionStatus // canonical …
  rawStatus            String            // … beside the bank's own word (ADR-021)
  reconciliationStatus ReconciliationStatus  // PENDING | COMPLETED | DISPUTED
  disputeReason        DisputeReason?        // AMOUNT_MISMATCH | UNKNOWN_REFERENCE | STATE_MISMATCH
  ...
}
```

The full schema is `packages/db/prisma/schema.prisma`; this excerpt keeps the fields the design turns on.

### Key schema decisions

**`Decimal(20,2)` not `Float` for money**
Float arithmetic is imprecise by design. `0.1 + 0.2 = 0.30000000000000004`.
Unacceptable for financial data. Decimal gives exact arithmetic.

**`uuid()` not auto-increment**
Sequential IDs expose user count and enable enumeration attacks.
UUIDs are opaque and safe to expose in URLs and API responses.

**Wallet created atomically with User**
A User without a Wallet is an invalid system state. Both are created inside a single
`$transaction` at registration; if wallet creation fails, the user record is rolled back.

**Balance is derived, not stored (ADR-012)**
Every movement writes immutable, signed `LedgerEntry` legs; a wallet's balance is `SUM(legs)`.
`Wallet.balance` is a cached projection written in the *same* transaction as the legs, inside the
same row lock, so `balance == SUM(legs)` holds continuously — including while a bank transfer is in
flight. Legs are append-only: a database trigger refuses `UPDATE` and `DELETE`, so a correction is
always new legs.

**Money in flight has its own account (ADR-016)**
Three account types: `CUSTOMER`, `SYSTEM` (the house, which carries the system's float and may go
negative), and `CLEARING`, which holds money the bank has not yet settled. The non-negative CHECK
exempts only `SYSTEM`, so clearing can never pay out money that never entered it. `Transaction`
records the customer's intent (house ↔ customer); the clearing account exists only in the legs, so it
never appears in a customer's history.

**The queue handoff is a row, not a `queue.add` (ADR-013)**
`TransactionOutbox` exists because Postgres and Redis cannot commit together. The intent to publish is
written in the *same* transaction as the money, so one commit means both "money moved" and "event
owed".

**Three dedup identities, one per boundary**
`IdempotencyRecord` (the client's `Idempotency-Key` — an HTTP retry), `BankRequest.eventId` (the outbox
row id — a queue redelivery), and `WebhookEvent.eventId` (the bank's delivery id — a callback
redelivery). Each is decided by a database constraint, never by an application-level "have I seen
this?" read. A fourth key is outbound: the bank dedups on `Transaction.id` (ADR-017).

---

## Request Flows

### POST /auth/register

```
Client sends: { firstName, lastName, email, phoneNumber, password }
  → Zod validates shape and types
  → Check uniqueness: email, phoneNumber
  → bcrypt.hash(password, cost=12)
  → prisma.$transaction([ createUser, createWallet(balance=0) ])
  → Sign JWT with userId
  → Return: { token, user: { id, email, firstName } }

Failure cases:
  → Email already registered   → 409 Conflict
  → Phone already registered   → 409 Conflict
  → Validation error           → 400 Bad Request
```

### POST /auth/login

```
Client sends: { email, password }
  → Zod validates
  → Find user by email
  → bcrypt.compare(password, user.passwordHash)
  → Sign JWT with userId
  → Return: { token, user: { id, email, firstName } }

Failure cases:
  → User not found             → 401 Unauthorized (not 404 — don't confirm email exists)
  → Wrong password             → 401 Unauthorized
```

### POST /wallet/transfer

```
Client sends: { receiverId, amount, note? }
Auth middleware: extracts senderId from JWT — never from body

  → Zod validates: amount > 0, receiverId is valid UUID
  → senderId !== receiverId
  → prisma.$transaction([
      lock both wallet rows (SELECT … FOR UPDATE, ordered by userId),
      check balance >= amount,
      create Transaction record (status: SUCCESS),
      write two balanced ledger legs (sender −amount, receiver +amount),
      update both cached balances (the projection of SUM(legs))
    ])
  → Return: { transactionId, newBalance, timestamp }

Failure cases:
  → Insufficient balance        → 402 Payment Required
  → Receiver not found          → 404 Not Found (also for a system account)
  → Sender === receiver         → 409 Conflict
  → DB transaction fails        → 500, rolled back atomically

Locking both rows in a deterministic order makes concurrent transfers from one wallet unable to
overdraft and opposite-direction transfers unable to deadlock (ADR-010).
```

### POST /wallet/banktransfer — the hold

```
Client sends: { direction: "deposit" | "withdrawal", amount }
Auth middleware: extracts userId from JWT — never from body
Header: Idempotency-Key

  → Zod validates: direction, amount (precision matches Decimal(20,2))
  → runIdempotent claims the key, then inside the SAME transaction:
      lock the source and clearing wallet rows (ordered by userId),
      check funds (withdrawal only),
      create Transaction (status: PENDING; parties = house ↔ customer),
      post the hold:   withdrawal  customer → clearing
                       deposit     house    → clearing
      insert TransactionOutbox row  ← the "submit this" intent, same commit
  → Return: { sender, receiver, amount, timestamp, status: PENDING, type }

Failure cases:
  → Insufficient balance        → 402 Payment Required
  → Wallet not found            → 404 Not Found
  → Key reused, other request   → 409 Conflict

No queue.add and no bank call on this path. If the process dies the instant after commit, the
submit is still owed — it is a committed row, not a lost in-flight call.
```

### Outbox pipeline (relay → BullMQ → worker → bank)

```
Producer commits ──► NOTIFY outbox_notification (part of that same transaction)
                            │
Relay (own process)  LISTEN ┘  + 5s fallback poll (NOTIFY is best-effort)
  → claim:   SELECT … WHERE publishStatus='PENDING' AND nextAttemptAt <= now()
             ORDER BY createdAt FOR UPDATE SKIP LOCKED LIMIT 200
  → publish: queue.add(...) per row, jobId = outbox row id   ← Redis only
  → mark:    PUBLISHED                                       ← SQL only
  → poison:  row-attributable failures back off; at 5 attempts → FAILED (visible,
             re-drivable). Infrastructure failures burn no attempts.

Worker (own process), per job — 8 attempts, exponential backoff from 2s with 50% jitter:
  → Zod-parse job.data (a bad payload stops the job; it is not retried to the same verdict)
  → claim:   INSERT BankRequest(eventId, status SUBMITTING) ON CONFLICT DO NOTHING
             — committed BEFORE the bank is called, so a crash leaves an in-doubt row,
               never an absence
  → existing row?  SUBMITTING → submit again (safe: the bank dedups on Transaction.id)
                   SUBMITTED  → done
                   HALTED     → done; re-drive is an operator action
  → submit:  POST /api/v1/transfer { pspReferenceId: Transaction.id, amount, currency }
             signed (HMAC over method, path and body), 5s wall-clock timeout
  → 202:     BankRequest → SUBMITTED, bankReference = trackingId. No ledger write.
  → refused (400/401/422) or unreadable 202, or last attempt failed:
             BankRequest → HALTED. Resolves nothing — the transfer may still have landed.
```

### POST /webhook/payment — settlement (bank → engine)

```
Mounted with express.raw, ahead of express.json: the signature is over the exact bytes.

  → verify X-Signature: HMAC over "{t}.{METHOD}{path}.{raw body}", |now − t| ≤ 300s,
    constant-time compare — only then JSON.parse and Zod-validate
  → one transaction:
      claim WebhookEvent(eventId, payload hash)
        same id + same payload  → duplicate, acknowledge, no effect
        same id + other payload → 422 IDEMPOTENCY_KEY_REUSED
      lock the Transaction row; match reference and amount (verified, never posted)
      classify against the transaction's CURRENT status:
        RETURN                       → record, acknowledge (the returns flow is not built)
        RECEIVED callback            → acknowledge
        PENDING + SETTLED/REJECTED   → apply
        same final state again       → already resolved
        contradicts a final state    → dispute (STATE_MISMATCH)
      upsert ReconciliationRecord (canonical + raw values, dispute if any)
      apply:  SETTLED   clearing → destination (customer for a deposit, house for a withdrawal)
              REJECTED  clearing → source (the hold is released, on the SAME transaction)
  → 200 for every recorded outcome — applied, duplicate or disputed
    400 malformed · 401 bad signature · 5xx could not record (the bank redelivers)
```

A failed bank transfer is one `Transaction` whose four legs net to zero (ADR-019). Dedup on the
delivery and the transition guard on state are independent: together they make duplicated and
out-of-order callbacks converge to one final state (ADR-018).

### GET /wallet/balance

```
Auth middleware: extracts userId from JWT
  → Fetch wallet by userId
  → Return: { balance, currency }
```

### GET /wallet/transactions

```
Auth middleware: extracts userId from JWT
Query params: page, limit (default: page=1, limit=20)
  → Fetch transactions where fromUserId OR toUserId = userId
  → Order by createdAt DESC
  → Return paginated list
```

---

## The Mock Bank

`apps/mock-bank` implements the bank side of the contract with its own database. It models no
customer accounts: it records instructions, settles them, and reports outcomes.

```
POST /api/v1/transfer          verify signature → validate → record TransferRequest (RECEIVED)
                               → 202. A repeat of the same reference is answered from the record;
                               the same reference with a different instruction is refused.
GET  /api/v1/transfer/{ref}    one resource in every state; 404 only if the reference never arrived

processor (own process)        claims RECEIVED requests (FOR UPDATE SKIP LOCKED), writes the outcome
                               event and the request's new status in one transaction
notifier  (own process)        claims due events with a lease (UPDATE … SKIP LOCKED … RETURNING),
                               delivers them signed, retries 6 times on a widening schedule, then
                               marks them EXHAUSTED; a refusal retrying cannot change → UNDELIVERABLE
```

Both background steps drain while batches come back full, sleep when they do not, back off on
failure, and finish the batch in flight on `SIGTERM`.

---

## Known Limitations

| Limitation | Risk | Status |
|---|---|---|
| No engine client for the bank's query endpoint | A `HALTED` request is resolved only if a callback arrives | Open — the reconciliation sweep is its caller |
| Returns are recorded and acknowledged, not applied | A bank-initiated return does not move money in the ledger | Open — the returns flow adds its own transaction (ADR-019) |
| Disputes are recorded, not alerted | A dispute is visible only by querying `ReconciliationRecord` | Open — relay metrics and re-drive (#28) |
| Outbox, dedup and webhook records are never pruned | Tables grow without bound | Open — retention (#27) |
| `Retry-After` is not honoured on a `429` | The worker retries on its own schedule | Open — contract Appendix B |
| No refresh tokens | A stolen JWT has no revocation path | Open (ADR-007) |
| ~~No row locking on transfer~~ | Concurrent transfers could overdraft | Fixed — ADR-010 |
| ~~No idempotency keys~~ | Duplicate requests sent money twice | Fixed — request-level dedup + retention reaper |
| ~~Balance as a scalar~~ | No audit or reconstruction | Fixed — ADR-012 |
| ~~Enqueue outside the transaction~~ | A crash after commit lost the event | Fixed — ADR-013 |
| ~~Pending bank legs skipped the projection~~ | `balance != SUM(legs)` while in flight | Fixed — ADR-016 (#26) |
| ~~Bank transfers never settled~~ | `PENDING` forever | Fixed — signed callbacks, ADR-018 / ADR-020 |
| ~~Consumer claimed before it acted~~ | A crash could lose a bank call | Fixed — request state + outbound key, ADR-017 |

---

## Infrastructure

### Local Development

```yaml
# docker-compose.yml runs:
db:     port 5432  (the engine's database)
bank:   port 5433  (the mock bank's own database)
redis:  port 6379  (BullMQ dispatch — no volume: jobs are disposable,
                    Postgres holds the truth and the relay re-publishes)
```

Six processes in development, each with its own entrypoint:

```
apps/api        npm run dev             API server        src/index.ts
                npm run dev:relay       outbox publisher  src/relay.ts   → src/outbox/relay.ts
                npm run dev:worker      bank submitter    src/worker.ts  → src/outbox/consumer.ts
apps/mock-bank  npm run dev             bank API (:8080)  src/index.ts
                npm run dev:processor   settlement        src/processor.ts
                npm run dev:notifier    callback delivery src/notifier.ts
```

No background process is required for the API to accept a bank transfer — the outbox row simply
accumulates as `PENDING` and drains when the relay comes back. That is the safe direction, and it is
what makes every background process restartable without ceremony.

### Environment Variables

```
apps/api
  DATABASE_URL           postgresql://…@localhost:5432/payments_system
  REDIS_URL              redis://localhost:6379   (no default in code — an unset value fails fast)
  JWT_SECRET             (set locally, never committed)
  PORT                   3001
  BANK_TRANSFER_HOST     http://localhost:8080
  BANK_TRANSFER_URL      /api/v1/transfer        (the path is also what the request signs)
  ENGINE_TO_BANK_SECRET  signs submits and queries
  BANK_TO_ENGINE_SECRET  verifies callbacks

apps/mock-bank
  DATABASE_URL           postgresql://…@localhost:5433/payments_system_mock_bank
  WEBHOOK_HOST           http://localhost:3001
  WEBHOOK_URL            /api/v1/webhook/payment
  ENGINE_TO_BANK_SECRET  verifies submits and queries
  BANK_TO_ENGINE_SECRET  signs callbacks
```

Every required variable is read through `requireEnv` at startup, so a missing one fails the process
before it accepts work.
