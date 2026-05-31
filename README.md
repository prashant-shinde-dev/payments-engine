# Payments Engine

A production-grade payments engine built to demonstrate engineering depth
in financial systems — not a tutorial project.

---

## What This Demonstrates

**Idempotent payment processing**
Duplicate requests (network retries, double-clicks) are detected and
short-circuited before they execute. Same request, same result, every time.

**Atomic double-entry transfers**
P2P transfers use database-level transactions with row locking.
Either both the debit and credit happen — or neither does.
No partial states. No overdrafts.

**Async bank webhook pipeline**
Bank operations (deposit, withdrawal) are processed asynchronously
via a job queue with retry, exponential backoff, and dead letter handling.
The system handles bank timeouts and failures without losing money.

**Typed error handling**
Every failure mode has a typed error class. Nothing is swallowed silently.
Errors are structured, logged, and mapped to correct HTTP status codes.

**Schema-first validation**
Zod schemas defined once in a shared package, used for both API validation
(security) and frontend form validation (UX). Frontend and backend
validation rules cannot drift.

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
         │
    PostgreSQL (via Prisma)
```

---

## Engineering Decisions

See [`docs/DECISIONS.md`](docs/DECISIONS.md) for full trade-off reasoning.

Key decisions:
- PostgreSQL over NoSQL — ACID is non-negotiable for money movement
- `Decimal(20,2)` not `Float` — float arithmetic loses cents
- Zod in a shared package — one schema, no FE/BE drift
- BullMQ over Kafka — right tool for our scale, documented trade-offs

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Monorepo | Turborepo + npm workspaces | Shared types, no drift |
| Backend | Express.js + TypeScript | Explicit, full control |
| Frontend | Next.js 14 (App Router) | Industry standard |
| Database | PostgreSQL + Prisma | ACID transactions |
| Validation | Zod | Runtime + compile-time, shared |
| Auth | JWT + refresh tokens | Stateless + revocable |
| Queue | BullMQ + Redis | Retry, DLQ, async jobs |
| Local infra | Docker + docker-compose | Reproducible, instant setup |

---

## Running Locally

**Prerequisites:** Node.js 20+, Docker Desktop

```bash
# 1. Clone
git clone https://github.com/prashantshinde/payments-engine
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
```

API runs on `http://localhost:3001`
Web runs on `http://localhost:3000`

---

## API Reference

### Auth

```
POST /auth/register
  Body: { firstName, lastName, email, phoneNumber, password }
  Returns: { token, user }

POST /auth/login
  Body: { email, password }
  Returns: { token, user }
```

### Wallet

```
GET  /wallet/balance
  Auth: Bearer token
  Returns: { balance, currency }

POST /wallet/transfer
  Auth: Bearer token
  Body: { receiverId, amount, note? }
  Returns: { transactionId, newBalance, timestamp }

GET  /wallet/transactions?page=1&limit=20
  Auth: Bearer token
  Returns: { transactions[], total, page, limit }
```

---

## Project Status

| Layer | Description | Status |
|---|---|---|
| Layer 1 | Core functionality — auth, wallet, P2P transfer | In Progress |
| Layer 2 | Correctness under pressure — idempotency, locking, async bank | Upcoming |
| Layer 3 | Scale — CQRS, fraud detection, reconciliation | Upcoming |

---

## Repository Workflow

This project follows a professional engineering workflow:

- **Conventional commits** — `feat:`, `fix:`, `refactor:`, `docs:`
- **Branch per feature** — `feat/001-monorepo-foundation`
- **PRs with descriptions** — including known limitations
- **Known limitations documented** — honestly, not hidden

---

*Built by Prashant Shinde*
