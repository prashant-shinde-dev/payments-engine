# Architecture

> This document describes the system as it currently exists.
> It is rewritten as the system evolves — not appended to.
> At any point it reads as a coherent whole, not a changelog.
> Last updated: Layer 2

---

## System Overview

A payments engine that enables users to move money in two ways:

- **P2P transfers** — send money directly to another user
- **Bank operations** — add funds from a linked bank account or withdraw to one

---

## High Level Design

```
┌─────────────────────────────────┐
│         Client (Next.js)        │
└────────────────┬────────────────┘
                 │ HTTPS
┌────────────────▼────────────────┐
│       API Server (Express)      │
│                                 │
│  Auth Middleware (JWT)          │
│  Input Validation (Zod)         │
│                                 │
│  /auth/*   → AuthService        │
│  /wallet/* → WalletService      │
└────────────────┬────────────────┘
                 │ ONE transaction: ledger legs + outbox row
┌────────────────▼──────────────────────────────┐
│                 PostgreSQL                    │
│  Users · Wallets · LedgerEntry · Transactions │
│  IdempotencyRecord · TransactionOutbox        │
│  BankRequest                                  │
└───────┬───────────────────────────────▲───────┘
        │ LISTEN/NOTIFY + claim          │ dedup key
┌───────▼─────────┐   BullMQ   ┌─────────┴───────┐
│  Outbox Relay   ├───────────►│  Bank  Worker   │
│  (publisher)    │   Redis    │  (consumer)     │
└─────────────────┘            └─────────────────┘
```

The request path writes to **one** store. Everything crossing into a second store
(Redis) happens out of band, in the relay — see ADR-013. The relay and worker are
separate processes (`npm run dev:relay`, `npm run dev:worker`), not threads of the API.

---

## Data Model

```
User ──1:1──► Wallet
User ──1:N──► Transaction  (as sender)
User ──1:N──► Transaction  (as receiver)
Wallet ──1:N──► LedgerEntry       (its signed legs; balance = SUM(legs))
Transaction ──1:N──► LedgerEntry  (the balanced legs of one movement)
Transaction ──1:1──► TransactionOutbox  (the async work that movement owes)
Transaction ──1:1──► BankRequest        (the instruction sent to the bank, and how far it got)
```

### Schema

```prisma
model User {
  id           String        @id @default(uuid())
  email        String        @unique
  phoneNumber  String        @unique
  firstName    String
  lastName     String
  passwordHash String
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt

  wallet       Wallet?
  sentTxns     Transaction[] @relation("SentTransactions")
  receivedTxns Transaction[] @relation("ReceivedTransactions")
}

model Wallet {
  id          String      @id @default(uuid())
  userId      String      @unique
  balance     Decimal     @db.Decimal(20, 2)  // cached projection of SUM(ledger legs)
  currency    String      @default("INR")
  accountType AccountType @default(CUSTOMER)   // CUSTOMER | SYSTEM (the house)
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt

  user   User          @relation(fields: [userId], references: [id])
  ledger LedgerEntry[]
}

model LedgerEntry {            // append-only; a wallet's balance = SUM(amount)
  id            String      @id @default(uuid())
  walletId      String
  transactionId String                          // groups the balanced legs of one movement
  amount        Decimal     @db.Decimal(20, 2)   // signed: debit −, credit +
  createdAt     DateTime    @default(now())

  wallet      Wallet      @relation(fields: [walletId], references: [id])
  transaction Transaction @relation(fields: [transactionId], references: [id])

  @@index([walletId])
  @@index([transactionId])
}

model Transaction {
  id         String            @id @default(uuid())
  fromUserId String
  toUserId   String
  amount     Decimal           @db.Decimal(20, 2)
  type       TransactionType
  status     TransactionStatus
  note       String?
  createdAt  DateTime          @default(now())

  fromUser User          @relation("SentTransactions", fields: [fromUserId], references: [id])
  toUser   User          @relation("ReceivedTransactions", fields: [toUserId], references: [id])
  ledger   LedgerEntry[]

  @@index([fromUserId, createdAt])
  @@index([toUserId, createdAt])
}

model IdempotencyRecord {        // request-level dedup: one claim per (user, key)
  userId         String
  idempotencyKey String
  requestHash    String          // sha256 of the request — detects key reuse
  response       String?         // the original result, replayed on a duplicate
  createdAt      DateTime @default(now())

  @@id([userId, idempotencyKey])
  @@index([createdAt])
}

model TransactionOutbox {                          // written INSIDE the transfer's transaction
  id            String            @id @default(uuid())  // the event identity the consumer dedupes on
  transactionId String            @unique              // 1:1 with the movement (command style, ADR-014)
  type          TransactionType
  status        TransactionStatus
  amount        Decimal           @db.Decimal(20, 2)
  userId        String
  publishStatus OutboxStatus      @default(PENDING)    // PENDING → PUBLISHED | FAILED
  attempts      Int               @default(0)
  nextAttemptAt DateTime          @default(now())      // backoff gate: a failing row steps aside
  createdAt     DateTime          @default(now())

  @@index([publishStatus, createdAt])                  // the relay's claim, oldest first
}

model BankRequest {              // committed BEFORE the bank is called
  eventId       String            @id      // the outbox row id: consumer-level dedup
  transactionId String            @unique  // also the key the bank dedups on (ADR-017)
  status        BankRequestStatus          // SUBMITTING → SUBMITTED | HALTED (ADR-020)
  bankReference String?                    // the bank's trackingId, once accepted
  lastError     String?
}

enum TransactionType {
  P2P_TRANSFER
  BANK_DEPOSIT
  BANK_WITHDRAWAL
  OPENING_BALANCE
}

enum OutboxStatus {
  PENDING
  PUBLISHED
  FAILED
}

enum TransactionStatus {
  PENDING
  SUCCESS
  FAILED
}

enum AccountType {
  CUSTOMER
  SYSTEM
}
```

### Key schema decisions

**`Decimal(20,2)` not `Float` for money**
Float arithmetic is imprecise by design. `0.1 + 0.2 = 0.30000000000000004`.
Unacceptable for financial data. Decimal gives exact arithmetic.

**`uuid()` not auto-increment**
Sequential IDs expose user count and enable enumeration attacks.
UUIDs are opaque and safe to expose in URLs and API responses.

**Wallet created atomically with User**
A User without a Wallet is an invalid system state.
Both are created inside a single Prisma `$transaction` at registration.
If wallet creation fails, the user record is rolled back.

**Balance is derived, not stored (ADR-012)**
Every movement writes immutable, signed `LedgerEntry` legs; a wallet's balance is
`SUM(legs)`. `Wallet.balance` is a cached projection written in the *same* transaction
as the legs, so it cannot drift — **for settled movements**. Bank transfers are the
open exception: they commit as `PENDING` and write their legs immediately while
deliberately not moving the projection, because a customer must not be able to spend
money the bank has not delivered. Until settlement resolves them, those two views of a
wallet disagree by the pending amount. See the limitations table below. Legs are append-only — a DB trigger blocks
`UPDATE`/`DELETE`. `accountType` marks the house/system account (the counter-leg for
opening-balance and, later, bank movements), which is exempt from the non-negativity
rule so it can carry the system's float.

**The queue handoff is a row, not a `queue.add` (ADR-013)**
`TransactionOutbox` exists because Postgres and Redis cannot commit together. The intent
to publish is written as a row in the *same* transaction as the money, so one commit means
both "money moved" and "event owed". Two dedup identities live in the schema for two
different boundaries: `IdempotencyRecord` keyed by the caller's `Idempotency-Key` (an HTTP
retry), and `BankRequest` keyed by the outbox row id (a queue redelivery), which also records
how far the bank call got. Both are decided by the database, never by an application-level "have I seen this?" read.

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
  → Fetch sender wallet
  → Check balance >= amount
  → prisma.$transaction([
      lock both wallet rows (SELECT … FOR UPDATE, ordered by userId),
      write two balanced ledger legs (sender −amount, receiver +amount),
      update both cached balances (the projection of SUM(legs)),
      create Transaction record (status: SUCCESS)
    ])
  → Return: { transactionId, newBalance, timestamp }

Failure cases:
  → Insufficient balance        → 422 Unprocessable Entity
  → Receiver not found          → 404 Not Found
  → Sender === receiver         → 400 Bad Request
  → DB transaction fails        → 500, rolled back atomically

✓ Concurrency-safe (Layer 2): the transfer locks BOTH wallet rows with
  SELECT … FOR UPDATE, ordered by userId, inside the transaction. Concurrent
  transfers from the same wallet can no longer overdraft, and opposite-direction
  transfers cannot deadlock. See ADR-010.

✓ Double-entry (Layer 2): each transfer is two balanced ledger legs that sum to
  zero; the wallet balance is a projection of SUM(legs), written in the same
  transaction so it can never drift. Legs are append-only (a DB trigger blocks
  UPDATE/DELETE), so corrections are new legs, never mutations. See ADR-012.
```

### POST /wallet/banktransfer

```
Client sends: { direction: "deposit" | "withdrawal", amount }
Auth middleware: extracts userId from JWT — never from body
Header: Idempotency-Key

  → Zod validates: direction, amount (precision matches Decimal(20,2))
  → runIdempotent claims the key, then inside the SAME transaction:
      lock both wallet rows (the user's and the house's, ordered by userId),
      check funds (withdrawal only — the house is exempt, it carries the float),
      write two balanced ledger legs,
      create Transaction record (status: PENDING — the bank has not answered yet),
      insert TransactionOutbox row  ← the "publish this" intent, same commit
  → Return: { sender, receiver, amount, timestamp, status: PENDING, type }

Failure cases:
  → Insufficient balance        → 402 Payment Required
  → Wallet not found            → 404 Not Found
  → Key reused, other request   → 409 Conflict

✗ No queue.add anywhere on this path. If the process dies the instant after commit,
  the event is still owed — it is a committed row, not a lost in-flight call.
```

### Outbox pipeline (relay → BullMQ → worker)

```
Producer commits ──► NOTIFY outbox_notification (part of that same transaction)
                            │
Relay (own process)  LISTEN ┘  + 5s fallback poll (NOTIFY is best-effort)
  → claim:   SELECT … WHERE publishStatus='PENDING' AND nextAttemptAt <= now()
             ORDER BY createdAt FOR UPDATE SKIP LOCKED LIMIT 200
             (SKIP LOCKED = the multi-instance claim: N relays partition the backlog)
  → publish: queue.add(...) for every claimed row      ← Redis only, no SQL
  → mark:    updateMany published rows → PUBLISHED     ← SQL only, no Redis
  → poison:  row-attributable failures get attempts+1 and an exponential
             nextAttemptAt; at 5 they become FAILED (visible, re-drivable).
             Transient (infra) failures abandon the batch and burn no attempts.

Worker (own process), per job — 8 attempts, exponential backoff from 2s with 50% jitter:
  → Zod-parse job.data (the queue is a JSON boundary; a bad payload is
    UnrecoverableError — permanent, not retried to the same verdict)
  → claim:   INSERT BankRequest(eventId, status SUBMITTING) ON CONFLICT DO NOTHING
             — committed BEFORE the bank is called, so a crash leaves an in-doubt row,
               never an absence
  → existing row?  SUBMITTING → submit again (safe: the bank dedups on Transaction.id)
                   SUBMITTED  → done
                   HALTED     → done; re-drive is an operator action
  → submit:  POST /api/v1/transfer { pspReferenceId: Transaction.id, amount, currency }
             signed (HMAC over timestamp, method, path and body), 5s wall-clock timeout
  → 202:     BankRequest → SUBMITTED, bankReference = trackingId. No ledger write.
  → refused (400/401/422), an unreadable 202, or the last attempt failed:
             BankRequest → HALTED. Resolves nothing — the transfer may still have landed.

Guarantees: the intent commits atomically with the money; delivery is at-least-once;
the attempt is recorded before the call, and a retry is safe because the bank
deduplicates on the transaction id (ADR-017). The worker never moves money: every
outcome arrives by callback (ADR-020).
```

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

## Known Limitations (Layer 1)

These are intentional. Each will be demonstrated as a failure, then fixed.

| Limitation | Risk | Fix in |
|---|---|---|
| No `SELECT FOR UPDATE` on transfer | Concurrent transfers can overdraft | ✅ Fixed — ADR-010 |
| No idempotency keys | Duplicate requests send money twice | ✅ Fixed — request-level dedup + retention reaper |
| Balance as scalar, not ledger | Cannot audit or reconstruct history | ✅ Fixed — ADR-012 |
| Enqueue outside the transaction | A crash after commit loses the event | ✅ Fixed — ADR-013 |
| Bank transfers never settle | They are submitted, but no callback is received, so they stay `PENDING` | Open — the webhook is the next change |
| A pending bank transfer writes legs but not the projection | `Wallet.balance != SUM(legs)` until settlement | ✅ Fixed — money in flight is held in a clearing account (#26) |
| Consumer claims before it acts | A crash mid-handler loses that one effect | ✅ Fixed — request state recorded before the call + outbound key (ADR-017) |
| No refresh tokens | Stolen JWT has no revocation path | Layer 2 |

---

## Infrastructure

### Local Development

```yaml
# docker-compose.yml runs:
postgres:  port 5432  (payments DB)
bank:      port 5433  (the mock bank's own database)
redis:     port 6379  (BullMQ dispatch — no volume: jobs are disposable,
                       Postgres holds the truth and the relay re-publishes)
```

Three processes in development, each with its own entrypoint:

```
npm run dev          API server        apps/api/src/index.ts
npm run dev:relay    outbox publisher  apps/api/src/relay.ts   → src/outbox/relay.ts
npm run dev:worker   bank consumer     apps/api/src/worker.ts  → src/outbox/consumer.ts
```

The mock bank runs as three more, from `apps/mock-bank`: `npm run dev` (its API, port 8080),
`npm run dev:processor` (settlement) and `npm run dev:notifier` (callback delivery). It is specified
by [`docs/bank-api-contract.md`](bank-api-contract.md); the engine submits to it, but does not yet receive its callbacks.

Neither background process is required for the API to accept a bank transfer — the
outbox row simply accumulates as `PENDING` and drains when the relay comes back. That
is the safe direction, and it is what makes the relay restartable without ceremony.

### Environment Variables

```
DATABASE_URL   postgresql://postgres:postgres@localhost:5432/payments
REDIS_URL      redis://localhost:6379   (no default in code — an unset value fails fast)
JWT_SECRET     (set locally, never committed)
PORT           3001
BANK_TRANSFER_HOST     http://localhost:8080
BANK_TRANSFER_URL      /api/v1/transfer      (the path is also what the request signs)
ENGINE_TO_BANK_SECRET  signs submits (contract §2.2)
```
