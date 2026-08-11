# Payments Engine

[![CI Pipeline](https://github.com/prashant-shinde-dev/payments-engine/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/prashant-shinde-dev/payments-engine/actions/workflows/ci.yml)

A study in **payment correctness** — money that moves exactly once under
concurrency, retries, and partial failure. The domain is deliberate: money is
the least forgiving place to get correctness wrong. This isn't a wallet
*product* (real-time bank rails already own consumer P2P) — it's the engineering
underneath one: the ledger, locking, and idempotency primitives that
marketplaces, escrow, and BNPL are built on.

---

## Where to Look First

If you're reviewing this as an engineer, the signal is concentrated in a few places:

- **Concurrency-safe transfers** — `apps/api/src/services/wallet.service.ts` + ADR-010.
  Both wallet rows are locked in a stable order, so concurrent transfers can't overdraft or deadlock.
- **Exactly-once money movement** — the idempotency layer (`apps/api/src/services/idempotency.ts`)
  and its bounded-retention reaper: duplicates move money once, and the record store stays bounded.
- **The dual-write problem** — `apps/api/src/outbox/` + ADR-013. A committed transfer must also
  tell a queue, and the two stores share no commit. The intent is written as a row in the *same*
  transaction, then relayed publish-then-mark, so a crash re-delivers instead of losing.
- **Trade-off reasoning** — [`docs/DECISIONS.md`](docs/DECISIONS.md). Each ADR argues the call —
  including the ones deliberately *deferred* or *rejected*. Knowing when **not** to build is the point.

---

## Core Capabilities

**Idempotent payment processing**
Duplicate requests (network retries, double-clicks) are detected and
short-circuited before they execute — same request, same result, every time.
Concurrent duplicates carrying the same key move money exactly once.

**Atomic, concurrency-safe transfers**
P2P transfers run inside database transactions with row-level locking:
either both the debit and credit commit, or neither does. Balances can never
go negative, and simultaneous transfers can't overdraft or deadlock.

**Append-only double-entry ledger**
Every movement writes immutable, signed legs that sum to zero; a wallet's balance is
`SUM(legs)`, not a number someone remembered to update. Corrections are new legs —
history is never rewritten.

**Transactional outbox**
Work that leaves the request (a bank call) is handed to a queue through Postgres, not
around it: the "publish this" intent commits atomically with the money, a relay claims
rows with `FOR UPDATE SKIP LOCKED` and publishes before marking, and the consumer
de-duplicates on the event id under a database key. Delivery is at-least-once by design;
duplicates produce no second effect.

**Typed error handling**
Every failure mode has a typed error class — nothing is swallowed silently.
Errors are structured, logged, and mapped to the correct HTTP status codes.

**Schema-first API validation**
Zod schemas defined once in a shared package validate every request at the
boundary, before it reaches business logic.

**Continuous verification**
Every push and pull request runs typecheck, lint, build, and an integration
suite against a real PostgreSQL — so the guarantees above are proven on a
clean machine, not just locally.

---

## Roadmap

Planned, not yet built:

**Async bank settlement**
Bank deposits and withdrawals currently commit as `PENDING` and are handed to the
worker; the bank call itself, its outbound idempotency key, the settlement callback,
and reconciliation of in-doubt requests are not built yet.

**Refresh-token authentication**
Short-lived access tokens backed by rotating refresh tokens.

---

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full system design.

```
Client (Next.js)
    │
API Server (Express + TypeScript)
    ├── Auth Middleware
    ├── Input Validation (Zod)
    ├── AuthService
    └── WalletService
         │  one transaction: ledger legs + outbox row
    PostgreSQL (via Prisma)
         │  claim (SKIP LOCKED) + LISTEN/NOTIFY
    Outbox Relay ──► BullMQ / Redis ──► Bank Worker
                                            │  dedup key
                                       PostgreSQL
```

---

## Engineering Decisions

See [`docs/DECISIONS.md`](docs/DECISIONS.md) for full trade-off reasoning.

Key decisions:

- PostgreSQL over NoSQL — ACID is non-negotiable for money movement
- `Decimal(20,2)` not `Float` — float arithmetic loses cents
- Zod in a shared package — one schema, no FE/BE drift
- Pessimistic row locking for transfers — locks acquired in a stable order, so concurrent transfers can't deadlock or overdraft
- Balance derived from an append-only ledger — the facts are stored, the state is computed
- Transactional outbox over CDC or a table-as-queue — one write plus a relay, keeping BullMQ's retry/backoff/DLQ

---

## Tech Stack

| Layer       | Technology                 | Why                            |
| ----------- | -------------------------- | ------------------------------ |
| Monorepo    | Turborepo + npm workspaces | Shared types, no drift         |
| Backend     | Express.js + TypeScript    | Explicit, full control         |
| Frontend    | Next.js 14 (App Router)    | Industry standard              |
| Database    | PostgreSQL + Prisma        | ACID transactions              |
| Validation  | Zod                        | Runtime + compile-time, shared |
| Auth        | JWT access tokens          | Stateless (refresh tokens planned) |
| Queue       | BullMQ + Redis             | Retry, backoff, DLQ, async jobs |
| Local infra | Docker + docker-compose    | Reproducible, instant setup    |

---

## Running Locally

**Prerequisites:** Node.js 20+, Docker Desktop

```bash
# 1. Clone
git clone https://github.com/prashant-shinde-dev/payments-engine
cd payments-engine

# 2. Start infrastructure
docker-compose up -d

# 3. Install dependencies
npm install

# 4. Set up environment
cp .env.example .env
# Edit .env — DATABASE_URL and JWT_SECRET

# 5. Run migrations
npm run db:migrate

# 6. Start development
npm run dev

# 7. In separate terminals — the outbox pipeline (optional; the API works without
#    them, events just queue up as PENDING until the relay runs)
npm run dev:relay  --workspace=@payments/api
npm run dev:worker --workspace=@payments/api
```

API runs on `http://localhost:3001`
Web runs on `http://localhost:3000`

---

## API Reference

### Auth

```
POST /api/v1/auth/register
  Body: { firstName, lastName, email, phoneNumber, password }
  Returns: { token, user }

POST /api/v1/auth/login
  Body: { email, password }
  Returns: { token, user }
```

### Wallet

```
GET  /api/v1/wallet/balance
  Auth: Bearer token
  Returns: { balance }

POST /api/v1/wallet/transfer
  Auth: Bearer token — the sender is taken from the token, never the body
  Header: Idempotency-Key
  Body: { receiver, amount }
  Returns: { sender, receiver, amount, timestamp, status, type }

POST /api/v1/wallet/banktransfer
  Auth: Bearer token — the account is taken from the token, never the body
  Header: Idempotency-Key
  Body: { direction: "deposit" | "withdrawal", amount }
  Returns: { sender, receiver, amount, timestamp, status: "PENDING", type }
  Commits the movement and its outbox row in one transaction; the relay
  publishes it to the worker out of band.

GET  /api/v1/wallet/transactions?page=1&pageSize=20
  Auth: Bearer token
  Returns: { transactions, total }
```

---

## Project Status

| Layer   | Description                                                   | Status      |
| ------- | ------------------------------------------------------------- | ----------- |
| Layer 1 | Core functionality — auth, wallet, P2P transfer               | Complete    |
| Layer 2 | Correctness under pressure — idempotency, locking, async bank | In Progress |
| Layer 3 | Reconciliation, observability, and failure-mode hardening     | Upcoming    |

---

## Repository Workflow

This project follows a professional engineering workflow:

- **Conventional commits** — `feat:`, `fix:`, `refactor:`, `docs:`
- **Branch per feature** — `feat/001-monorepo-foundation`
- **PRs with descriptions** — including known limitations
- **Known limitations documented** — honestly, not hidden

---

_Built by Prashant Shinde_
