# Architecture

> This document describes the system as it currently exists.
> It is rewritten as the system evolves — not appended to.
> At any point it reads as a coherent whole, not a changelog.
> Last updated: Layer 1

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
                 │
┌────────────────▼────────────────┐
│        PostgreSQL               │
│  Users · Wallets · Transactions │
└─────────────────────────────────┘
```

Intentionally simple. The async layer (BullMQ, Redis, bank webhook service)
is introduced in Layer 2 when we demonstrate the failure that requires it.

---

## Data Model

```
User ──1:1──► Wallet
User ──1:N──► Transaction  (as sender)
User ──1:N──► Transaction  (as receiver)
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
  id        String   @id @default(uuid())
  userId    String   @unique
  balance   Decimal  @db.Decimal(20, 2)
  currency  String   @default("INR")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  user User @relation(fields: [userId], references: [id])
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

  fromUser User @relation("SentTransactions", fields: [fromUserId], references: [id])
  toUser   User @relation("ReceivedTransactions", fields: [toUserId], references: [id])

  @@index([fromUserId, createdAt])
  @@index([toUserId, createdAt])
}

enum TransactionType {
  P2P_TRANSFER
  BANK_DEPOSIT
  BANK_WITHDRAWAL
}

enum TransactionStatus {
  PENDING
  SUCCESS
  FAILED
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
      debit sender wallet,
      credit receiver wallet,
      create Transaction record (status: SUCCESS)
    ])
  → Return: { transactionId, newBalance, timestamp }

Failure cases:
  → Insufficient balance        → 422 Unprocessable Entity
  → Receiver not found          → 404 Not Found
  → Sender === receiver         → 400 Bad Request
  → DB transaction fails        → 500, rolled back atomically

⚠ Known Layer 1 gap: no SELECT FOR UPDATE
  Concurrent transfers to the same wallet can overdraft.
  Demonstrated and fixed in Layer 2.
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
| No `SELECT FOR UPDATE` on transfer | Concurrent transfers can overdraft | Layer 2 |
| No idempotency keys | Duplicate requests send money twice | Layer 2 |
| No async bank processing | Timeout mid-transfer loses money | Layer 2 |
| No refresh tokens | Stolen JWT has no revocation path | Layer 2 |
| Balance as scalar, not ledger | Cannot audit or reconstruct history | Layer 2 |

---

## Infrastructure

### Local Development

```yaml
# docker-compose.yml runs:
postgres:  port 5432  (payments DB)
```

Redis is not in the docker-compose yet — introduced in Layer 2.

### Environment Variables

```
DATABASE_URL   postgresql://postgres:postgres@localhost:5432/payments
JWT_SECRET     (set locally, never committed)
PORT           3001
```
