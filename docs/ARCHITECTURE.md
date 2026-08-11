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

model IdempotencyJobRecord {      // consumer-level dedup: the outbox row id, once
  eventId   String   @id
  createdAt DateTime @default(now())
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
retry), and `IdempotencyJobRecord` keyed by the outbox row id (a queue redelivery). Both
are decided by the database, never by an application-level "have I seen this?" read.

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

Worker (own process)
  → Zod-parse job.data (the queue is a JSON boundary; a bad payload is
    UnrecoverableError — permanent, not retried five times to the same verdict)
  → claim:  INSERT IdempotencyJobRecord(eventId) ON CONFLICT DO NOTHING
            no rows inserted ⇒ already handled ⇒ return, no second effect
  → act:    the bank call — a log stand-in until the bank client lands

Guarantees: the intent commits atomically with the money; delivery is at-least-once;
the effect is de-duplicated by the database. Publish-then-mark means a crash between
the two re-delivers rather than losing. See ADR-013, and ADR-015 for the one window
that is deliberately left open.
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

## Known Limitations (Layer 1)

These are intentional. Each will be demonstrated as a failure, then fixed.

| Limitation | Risk | Fix in |
|---|---|---|
| No `SELECT FOR UPDATE` on transfer | Concurrent transfers can overdraft | ✅ Fixed — ADR-010 |
| No idempotency keys | Duplicate requests send money twice | ✅ Fixed — request-level dedup + retention reaper |
| Balance as scalar, not ledger | Cannot audit or reconstruct history | ✅ Fixed — ADR-012 |
| Enqueue outside the transaction | A crash after commit loses the event | ✅ Fixed — ADR-013 |
| Bank transfers never settle | A `PENDING` transaction is never resolved | Layer 2 |
| A pending bank transfer writes legs but not the projection | `Wallet.balance != SUM(legs)` until settlement — the ledger asserts a movement the balance does not | Layer 2 — settlement decides whether pending legs wait, or post to a clearing account |
| Consumer claims before it acts | A crash mid-handler loses that one effect | Layer 2 — closed by the bank call's outbound key (ADR-015) |
| No refresh tokens | Stolen JWT has no revocation path | Layer 2 |

---

## Infrastructure

### Local Development

```yaml
# docker-compose.yml runs:
postgres:  port 5432  (payments DB)
redis:     port 6379  (BullMQ dispatch — no volume: jobs are disposable,
                       Postgres holds the truth and the relay re-publishes)
```

Three processes in development, each with its own entrypoint:

```
npm run dev          API server        apps/api/src/index.ts
npm run dev:relay    outbox publisher  apps/api/src/relay.ts   → src/outbox/relay.ts
npm run dev:worker   bank consumer     apps/api/src/worker.ts  → src/outbox/consumer.ts
```

Neither background process is required for the API to accept a bank transfer — the
outbox row simply accumulates as `PENDING` and drains when the relay comes back. That
is the safe direction, and it is what makes the relay restartable without ceremony.

### Environment Variables

```
DATABASE_URL   postgresql://postgres:postgres@localhost:5432/payments
REDIS_URL      redis://localhost:6379   (no default in code — an unset value fails fast)
JWT_SECRET     (set locally, never committed)
PORT           3001
```
