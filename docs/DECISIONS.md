# Architecture Decision Records

> Every significant technical decision is recorded here.
> Format: ADR (Architecture Decision Record)
>
> Rules:
> - Written at the moment the decision is made
> - Never edited after the fact — that would be dishonest
> - Status field handles evolution: Accepted → Superseded by ADR-XXX
> - Each entry answers: context, options, decision, rationale, trade-offs
>
> This file tells the engineering story of this project.
> The decisions themselves matter less than the reasoning behind them.

---

## ADR-001: Turborepo Monorepo over Separate Repositories

**Status:** Accepted
**Date:** Layer 1

**Context:**
Three deployable units (API, Web, Bank Webhook) need to share TypeScript
types and Zod validation schemas. Without sharing, types defined on the
backend must be manually duplicated on the frontend — a real source of bugs
when one side updates and the other doesn't.

**Options Considered:**

| Option | Pro | Con |
|---|---|---|
| Separate repos | Independent deploys, clear ownership | Type drift, no sharing, painful cross-repo changes |
| Turborepo monorepo | Shared packages, single source of truth, parallel builds, build caching | All services in one repo |
| Nx | More powerful, plugin ecosystem | Overkill at this scale, steeper learning curve |

**Decision:** Turborepo with npm workspaces.

**Rationale:**
Shared `packages/types` and `packages/zod-schemas` eliminate an entire class
of FE/BE drift bugs. Turborepo's build caching means no performance penalty
for the monorepo structure. Simpler than Nx for a two-app, one-backend setup.

**Trade-offs:**
A bad commit can affect all services simultaneously.
Mitigated by: per-package CI checks and separate deployment pipelines per app.

**Revisit when:** Team grows beyond ~5 engineers and ownership boundaries require separate repos.

---

## ADR-002: PostgreSQL over NoSQL

**Status:** Accepted
**Date:** Layer 1

**Context:**
The core operation — transferring money between two wallets — requires
that either both the debit and credit happen, or neither does.
This is a hard atomicity requirement.

**Options Considered:**

| Option | Pro | Con |
|---|---|---|
| PostgreSQL | ACID transactions, row-level locking, Decimal type, mature ecosystem | Harder to scale horizontally than NoSQL |
| MongoDB | Flexible schema, horizontal scale | No true multi-document ACID (pre-4.0). Eventual consistency unacceptable for money |
| DynamoDB | Managed, scales infinitely | Eventual consistency by default, no joins, expensive at scale |

**Decision:** PostgreSQL.

**Rationale:**
Money movement requires ACID. "Eventual consistency" is not a trade-off
we can make when ₹500 is moving between two accounts.
PostgreSQL gives us: atomic multi-table transactions, row-level locking
(critical for Layer 2 race condition fix), and the Decimal type for exact
monetary arithmetic. These are non-negotiable for a payments engine.

**Trade-offs:**
Vertical scaling limit. Horizontal sharding is complex.
Mitigated by: read replicas for query load, connection pooling (PgBouncer) at scale.

**Revisit when:** >10M users with query patterns that read replicas cannot handle.

---

## ADR-003: Prisma over Raw SQL and Other ORMs

**Status:** Accepted
**Date:** Layer 1

**Context:**
We need a database client with type safety, migration management,
and strong TypeScript integration. Manual SQL means manual type definitions
that drift from the actual schema.

**Options Considered:**

| Option | Pro | Con |
|---|---|---|
| Prisma | Auto-generated TS types, migration history, excellent DX, industry standard | Slight abstraction overhead, raw SQL needed for `SELECT FOR UPDATE` |
| TypeORM | Familiar to Java/Spring engineers | Decorator-based (experimental TS feature), weaker type inference |
| Drizzle | Lightweight, pure TypeScript, SQL-like API | Smaller ecosystem, more verbose for complex queries |
| Raw SQL (pg/postgres.js) | Full control, zero overhead | Manual type definitions, manual migration management |

**Decision:** Prisma.

**Rationale:**
Schema-generated TypeScript types mean the database and application
types are always in sync — no manual `interface User` that drifts from
the actual table. Migration history is tracked automatically.
Prisma is a mature, widely adopted client, which keeps onboarding
and long-term maintenance cost low.

**Trade-offs:**
`SELECT FOR UPDATE` requires `prisma.$queryRaw` — slightly less ergonomic.
Prisma's query engine adds a small cold-start overhead in serverless contexts
(not relevant for our Express server).

**Revisit when:** Performance profiling shows Prisma overhead is a measurable bottleneck.

---

## ADR-004: Zod in Shared Package for Validation

**Status:** Accepted
**Date:** Layer 1

**Context:**
User input must be validated at the API boundary (security).
The same rules should run on the frontend (UX — instant feedback).
Without sharing, the two validation definitions will drift.

**Options Considered:**

| Option | Pro | Con |
|---|---|---|
| Zod (shared) | Runtime + compile-time, TypeScript-first, one schema for FE+BE, excellent inference | Slightly verbose for deeply nested schemas |
| Joi | Mature, widely used | Not TypeScript-first, awkward type inference |
| Yup | Popular in React ecosystem | Async-first design adds complexity, weaker TS support |
| class-validator | NestJS standard, decorator-based | Decorators are experimental, doesn't work with plain objects |

**Decision:** Zod, defined once in `packages/zod-schemas`, imported by both API and Web.

**Rationale:**
One schema definition gives: runtime validation on the server (security),
TypeScript types inferred automatically (`z.infer<typeof schema>`),
and the same schema reusable on the client for form validation.
No drift between frontend and backend validation rules — ever.

---

## ADR-005: Decimal(20,2) for All Monetary Values

**Status:** Accepted
**Date:** Layer 1

**Context:**
Monetary amounts must be stored in the database. The choice of data type
directly determines whether monetary arithmetic is exact — getting it
wrong corrupts balances in ways that are hard to detect and harder to reverse.

**Options Considered:**

| Option | Pro | Con |
|---|---|---|
| Float / Double | Simple, native in most languages | `0.1 + 0.2 = 0.30000000000000004`. Categorically wrong for money |
| Integer (store paise) | Exact, fast arithmetic | Easy off-by-100x errors, every developer must remember the conversion |
| Decimal(20,2) | Exact decimal arithmetic, human-readable, no conversion needed | Marginally slower than integer |

**Decision:** `Decimal(20,2)` — 20 significant digits, 2 decimal places.

**Rationale:**
Floats are wrong for money without exception. Integer (storing paise) is
technically correct but introduces a cognitive tax on every developer who
touches the codebase. Decimal gives exact arithmetic and human-readable
values with no conversion layer. 20 digits handles values up to
₹999,999,999,999,999,999.99 — sufficient for any realistic scenario.

---

## ADR-006: Docker for Local Development Infrastructure

**Status:** Accepted
**Date:** Layer 1

**Context:**
PostgreSQL must run locally for development. Two options: install natively
on the developer's machine, or run via Docker.

**Options Considered:**

| Option | Pro | Con |
|---|---|---|
| Native install | No Docker knowledge required | "Works on my machine" problem, setup instructions vary by OS |
| Docker + docker-compose | Reproducible, anyone who clones repo can run it instantly | Requires Docker Desktop |

**Decision:** Docker with `docker-compose.yml`.

**Rationale:**
`docker-compose up` gives any engineer (or hiring manager) a running
Postgres instance in seconds with no setup. This is a developer experience
signal: the person who built this repo thought about people consuming it.
Native installs create OS-specific setup instructions that inevitably break.

**Trade-offs:**
Requires Docker Desktop. Accepted — Docker is standard in any engineering workflow.

---

## ADR-007: JWT Access Token Only in Layer 1

**Status:** Accepted — to be superseded in Layer 2
**Date:** Layer 1

**Context:**
API requests must be authenticated. Two common patterns: stateless JWT
or stateful sessions. A more secure JWT implementation uses short-lived
access tokens paired with long-lived refresh tokens.

**Options Considered:**

| Option | Pro | Con |
|---|---|---|
| Session (DB-backed) | Instantly revocable | DB lookup on every request, sticky sessions for horizontal scale |
| JWT access token only | Stateless, no DB lookup per request, simple | Cannot revoke before expiry — stolen token = permanent access until expiry |
| JWT + refresh token rotation | Revocable, short attack window, stateless for access | More complex, two-token management, httpOnly cookie handling |

**Decision:** JWT access token only for Layer 1.

**Rationale:**
A stateless JWT is the simplest correct implementation for first-pass
authentication. The known weakness (no revocation before expiry) is bounded
by a short token TTL (15 minutes), which caps the exposure window of a
leaked token until refresh-token rotation lands.

**Known weakness:** Stolen JWT is valid until expiry. No way to invalidate
on logout or suspicious activity. This is a documented, intentional gap.

**Superseded by:** ADR-TBD (Layer 2) — refresh token rotation + httpOnly cookies.

---

## ADR-008: npm over pnpm

**Status:** Accepted
**Date:** Layer 1

**Context:**
Package manager choice for the monorepo. Turborepo works with both.

**Options Considered:**

| Option | Pro | Con |
|---|---|---|
| npm | Universal, no additional tooling, developer already uses it | Slower installs, less strict about phantom dependencies |
| pnpm | Faster, strict dependency isolation, better monorepo support | Additional tool to learn, slightly different commands |

**Decision:** npm.

**Rationale:**
Developer familiarity reduces friction in Layer 1. The goal of Layer 1
is a working system — not optimising the toolchain. pnpm's advantages
(speed, strict isolation) matter more at scale or with larger teams.

**Revisit when:** Install times become noticeable or phantom dependency bugs surface.

---

## ADR-009: BullMQ + Redis for Job Queue (Layer 2 — Pre-recorded)

**Status:** Pending — decision pre-recorded before implementation
**Date:** Pre-Layer 2

**Context:**
Bank operations are asynchronous. A bank withdrawal doesn't settle
instantly — the bank processes it and sends a callback. We need a queue
that handles: retry on failure, dead letter queue for permanently failed
jobs, and reliable processing across server restarts.

**Options Considered:**

| Option | Pro | Con |
|---|---|---|
| BullMQ + Redis | First-class Node.js/TS support, retries + DLQ built-in, runs on Redis (already in stack for rate limiting) | Not a true message broker, potential data loss if Redis not persisted |
| RabbitMQ | True AMQP broker, complex routing, multiple independent consumers | Separate infrastructure, overkill for our routing needs |
| Kafka | Event streaming, replay capability, audit log, high throughput | Massively over-engineered at our scale, significant ops complexity |
| AWS SQS | Managed, reliable, cheap at low volume | Cloud lock-in, complicates local development |
| pg-boss | Queue backed by existing PostgreSQL, no new infra | Slower, less feature-rich, mixes queue and DB concerns |

**Decision:** BullMQ + Redis.

**Rationale:**
We already need Redis for rate limiting — BullMQ adds no new infrastructure.
First-class TypeScript support, built-in exponential backoff retry, and
dead letter queue pattern cover our requirements. The trade-off vs Kafka
(no event replay) is acceptable: we don't need to rebuild state from an
event log at our scale. The trade-off vs RabbitMQ (simpler routing) is
acceptable: our job types (bank jobs, notification jobs) don't need
complex fanout topologies.

**Trade-offs:**
No event replay — if we ever need to rebuild wallet state from the event log,
this is the wrong tool. Redis persistence must be configured (AOF or RDB)
to prevent job loss on restart.

**Revisit when:**
- Event replay becomes a requirement → evaluate Kafka
- Complex routing with multiple independent consumers → evaluate RabbitMQ
- >100k jobs/day and Redis becomes a bottleneck → evaluate Kafka
