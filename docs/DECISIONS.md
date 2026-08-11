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

**Status:** Accepted — implemented in Layer 2; the transactional handoff into it is ADR-013
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

---

## ADR-010: Pessimistic Row Locking + Deterministic Order for Concurrent Transfers

**Status:** Accepted
**Date:** Layer 2

**Context:**
A transfer reads a balance, decides, then writes. Under concurrency two transfers from
the same wallet can read the same stale balance, both pass the funds check, and both
debit → lost update → negative balance. A transfer also touches two rows (debit sender,
credit receiver); concurrent opposite-direction transfers can deadlock if those rows are
locked in inconsistent order.

**Decision:**
Pessimistic locking with `SELECT … FOR UPDATE` **inside** the transaction, locking **both**
wallet rows in a single statement ordered by `userId` ascending, under the default
READ COMMITTED isolation. All reads/writes use the transaction client (`txn`), never the
global pooled client.

**Rationale:**
- **Blocking over retry.** `FOR UPDATE` (block, then re-read fresh) over Serializable +
  client-side retry → simpler app code; per-wallet contention is acceptable at this scale.
- **Order by the row, not the role.** Ordering the single lock statement by the stable
  `userId` value makes every transfer acquire locks in the same global order → no deadlock
  cycle, regardless of direction. Ordering by sender/receiver *role* would flip with
  direction and reintroduce the deadlock.
- **Lock both up front.** With both rows locked by the one statement, the later
  `increment`/`decrement` acquire no new locks, so credit-vs-debit order is irrelevant.
- **`txn`, not `prisma`.** The lock lives on the transaction's connection; reading via the
  global client would run on a different pooled connection that doesn't hold the lock.

**Trade-offs:**
Concurrent transfers from the *same* wallet serialize (throughput bound by lock-hold time).
Relies on PostgreSQL acquiring locks in `ORDER BY` order — verified by a forced-delay
deadlock test in both directions. The `ORDER BY` is load-bearing and must not be removed.

**Revisit when:**
- A single wallet becomes a write hotspot → queue-per-wallet or optimistic concurrency
- A future operation must read *both* balances as decision inputs → reassess lock scope

---

## ADR-011: Transfer Idempotency Deferred to a Dedicated Ticket

**Status:** Accepted — deferred
**Date:** Layer 2

**Context:**
`POST /wallet/transfer` is a money-moving mutation. A client retry (timeout, dropped
connection) could submit the same transfer twice and move money twice. Idempotency — e.g.
an `Idempotency-Key` header with stored-result replay — prevents this.

**Decision:**
Idempotency is **out of scope** for the concurrency-safety work and deferred to a dedicated
follow-up ticket.

**Rationale:**
This ticket's scope is correctness under *concurrent* execution (lost update, deadlock).
Retry-safety is an orthogonal concern with its own design surface — key storage, replay
semantics, unique-constraint races. Bundling them would bloat the change and muddy review;
tracking it separately keeps each change atomic and reviewable.

**Consequence:**
Until the follow-up ships, a retried transfer request can double-move money. This is a
known, documented gap — surfaced in the PR's Known Limitations — not a silent omission.

---

## ADR-012: Append-Only Double-Entry Ledger; Balance Derived, Not Stored

**Status:** Accepted
**Date:** Layer 2

**Context:**
Through Layer 1 and most of Layer 2, a wallet's balance was a single `Decimal` column that the
transfer mutated in place (`decrement`/`increment`), while a separate `Transaction` row recorded
that a transfer happened. Nothing tied the two together: a stray `UPDATE`, a bug, or a new code
path could move the scalar without a matching movement, and the balance could not answer the one
question a payments system must answer on demand — *"prove why this balance is €41.50."* The
balance was an opinion with no evidence: it stored the result of a computation and discarded the
inputs, so it could not be audited, reconstructed, or reconciled, and there was nowhere clean to
represent the PENDING money the async bank flow (#010) needs. This was the last open Layer-1
known limitation ("balance as scalar, not ledger").

**Decision:**
Money movement is recorded as an **append-only, double-entry ledger**. Each movement writes one
immutable **leg per account** it touches (`LedgerEntry`: `walletId`, signed `amount`,
`transactionId`), and a wallet's balance is **defined as `SUM(legs)`**. The `Wallet.balance`
scalar is retained only as an O(1) **projection** of that sum. Specifically:

- **Per-account signed legs.** A transfer of X writes two legs — sender `−X`, receiver `+X`.
  Direction is the sign, so both invariants (a movement's legs sum to zero; balance = sum of an
  account's legs) are a single `SUM` with no `CASE` branching. Non-negativity therefore lives on
  the *balance*, never the leg (a debit leg is legitimately negative).
- **House/system account.** External and opening-balance movements are balanced against a
  system-owned house account, so *every* movement sums to zero with no exceptions. The house is a
  first-class account distinguished by `accountType` (`CUSTOMER | SYSTEM`); the customer-protecting
  invariants (non-negative-balance CHECK, overdraft guard, authentication) **allowlist `CUSTOMER`**,
  so the house may go negative (its balance mirrors the system's float/liability) and can never
  authenticate. New account kinds are safe by default.
- **Projection written atomically.** The cached `Wallet.balance` is updated in the same
  `$transaction` as the legs, inside the existing `SELECT … FOR UPDATE` lock (ADR-010), so it can
  never drift from `SUM(legs)`.
- **Immutability enforced at the database.** A `BEFORE UPDATE OR DELETE` trigger on `LedgerEntry`
  rejects any mutation. A trigger — not `REVOKE` — is used because the application connects as the
  database owner/superuser, which bypasses privilege checks; a trigger binds regardless of role.
  Corrections are expressed as new, balanced legs, never edits.
- **Migration seeds opening balances.** Existing wallets are backfilled with one balanced
  `house → customer` opening movement equal to each wallet's current balance, so
  `SUM(legs) == balance` holds from the first read. The pre-ledger `Transaction` log is not
  replayed (it never recorded opening balances and cannot be trusted to reproduce real balances).

**Rationale:**
Store the facts (immutable movements); derive the state (balance). The correct claim was never
"the balance is X" but "the balance is X *because* of these movements." Deriving balance from an
immutable ledger makes it **provable** (enumerate the legs), **reconstructable** (rebuild the
scalar from `SUM(legs)` after any corruption), and **reconcilable** (assert `cache == SUM(legs)`
now, `SUM(legs) == real escrow` later). Double-entry's "every movement sums to zero" is a
continuous, cheap integrity check a scalar can never offer, and append-only makes the audit trail
trustworthy — near money, the history *is* the product. None of these are possible with a stored
scalar, no matter how correct the surrounding code is.

**Consequence:**
Correctness now rests on two documented invariants — `balance == SUM(legs)` (kept true by the
same-transaction projection write) and *every movement's legs sum to zero* (conservation) — both
proven by executable tests (reconstruction, conservation, large-magnitude precision, and
DB-enforced immutability). `Wallet.balance` is now a cache: read on the hot path, rebuildable from
the ledger, verified by reconciliation. The ledger is the substrate #010 builds PENDING money and
saga compensation on, and the Layer-3 reconciliation job checks. A privileged system account now
exists and must stay gated behind `accountType`, so its exemptions (negative balance, no overdraft
check, no auth) can never leak to a customer wallet.

**Trade-offs / rejected alternatives:**
- *Stored scalar as source of truth* — rejected: unprovable, silently drifts, no home for PENDING money.
- *Single-entry log (one row per transfer)* — rejected: cannot answer "whose balance," no counter-leg for external money.
- *Debit/credit tag instead of a signed amount* — rejected: forces a `CASE` into every read; signed amounts keep both invariants a plain `SUM`.
- *Nullable `transactionId` or a separate `movementId` grouping key* — rejected: house-as-system-account makes every movement a real `Transaction`, so the FK is always present and doubles as the grouping key.
- *Replaying the old `Transaction` log at migration* — rejected: it never recorded opening balances and could rewrite real balances; seeding the current balance is provably consistent.
- *`REVOKE UPDATE, DELETE` for immutability* — rejected: bypassed by the owner/superuser the app connects as; a trigger binds unconditionally.

**Revisit when:**
- The house's single negative balance needs to split by origin (escrow, fee, revenue, promo/equity) → add `accountType` values; the allowlist keeps new kinds safe by default.
- `SUM(legs)` on the reconciliation path becomes a bottleneck → time-partition `LedgerEntry` or keep a periodic checkpoint (deferred; the indexed sum is sufficient now).

---

## ADR-013: Transactional Outbox for the Dual-Write Problem

**Status:** Accepted
**Date:** Layer 2

**Context:**
Every correctness guarantee in the engine so far — deterministic lock ordering (ADR-010),
idempotent transfers (ADR-011's successor), the derived ledger (ADR-012) — held because every write
landed in one PostgreSQL transaction, so "all or nothing" was free. The async bank flow breaks that:
a committed transfer must also tell a second system (a BullMQ queue on Redis) to do work. Two stores,
no shared commit.

There is no ordering of those two writes that is safe. Commit first and enqueue after: a crash in
between leaves money moved and the job gone, with nothing in the system recording that it was owed.
Enqueue first (or inside the transaction): a rollback leaves a job for a transfer that never
happened, and the worker faithfully acts on a phantom. This is the **dual-write problem**, and it is
what every "just `await` both" instinct walks into.

**Options Considered:**

| Option | Pro | Con |
|---|---|---|
| `await` both writes in sequence | Trivial | Loses events in the crash window; the loss is silent and unrecoverable |
| `queue.add` inside the `$transaction` | Feels atomic | It isn't — Redis cannot participate in a Postgres commit; a rollback cannot un-send a job |
| Two-phase commit (XA) | Genuinely atomic | Requires a coordinator, blocks on coordinator failure, unsupported by Redis; nobody reaches for this in production |
| CDC / transaction-log tailing (Debezium) | No producer changes; the log is already the truth | Kafka Connect + a broker + connector ops for one queue hop; operationally heavier than the entire engine |
| Outbox table *as* the queue (pg-boss style) | One store, no relay, no Redis | Forfeits BullMQ's retry/backoff/delay/concurrency/DLQ machinery — all of which would be rebuilt by hand, worse |
| **Transactional outbox + relay** | Collapses the dual write into one write plus an at-least-once pump | Delivery becomes at-least-once, so the consumer must be idempotent; one more process to run |

**Decision:** Transactional outbox with a separate relay process.

- **Producer.** `bankTransfer` inserts one `TransactionOutbox` row **inside the same `$transaction`**
  as the ledger legs. One commit means *money moved* **and** *event owed*, atomically. There is no
  `queue.add` anywhere in the request path.
- **Relay.** A long-running process claims pending rows with
  `SELECT … WHERE "publishStatus" = 'PENDING' AND "nextAttemptAt" <= now() ORDER BY "createdAt"
  FOR UPDATE SKIP LOCKED LIMIT 200`. `SKIP LOCKED` is the multi-instance claim — ADR-010's primitive
  with the opposite requirement: there a second writer had to *wait*, here it must *skip*, so N relays
  partition the backlog instead of serializing or double-publishing. The claim is decided by the
  database; there is no application-level coordination.
- **Publish-then-mark.** `queue.add` runs first, the `publishStatus` flip second, both inside the
  relay's transaction. The crash gap between them cannot be removed, only pointed: publish-then-mark
  fails toward *re-delivery* (benign — the consumer dedupes), mark-then-publish fails toward *loss*
  (a row marked done that nobody ever received, silent forever).
- **Phase separation.** All `queue.add` calls run first (Redis only), then all outcome writes run in
  bulk (SQL only). No savepoints: the only fallible per-row step touches a different connection
  entirely, so a failed row leaves no partial DB state to unwind, and 200 subtransactions per batch
  never exist. The standing rule this produced: *never let a fallible foreign call and a SQL write
  share a `try` block* — catching a SQL error inside a transaction turns the following `COMMIT` into a
  `ROLLBACK` that Postgres reports as success.
- **Poison termination.** Row-attributable publish failures increment `attempts` and set an
  exponential `nextAttemptAt` (5s → 25s → 2m → 10m cap); at 5 attempts the row becomes `FAILED` —
  visible and re-drivable, never deleted, and never head-of-line-blocking the rows behind it.
  Infrastructure failures are classified as *transient*, rethrown, and burn no attempts, because a
  Redis blip fails every row identically and would otherwise mark the whole backlog `FAILED` in 25s.
- **Wake-up.** A statement-level `AFTER INSERT` trigger issues `NOTIFY outbox_notification`; the relay
  holds a dedicated `LISTEN` connection. NOTIFY is part of the producer's transaction (delivered on
  commit, discarded on rollback) and carries no payload — it means "go look", never "here is a row" —
  so it is not a second dual write. Delivery is best-effort, which is why the 5s fallback poll stays.
- **Consumer.** Idempotent on the outbox row id, decided by the database: an
  `IdempotencyJobRecord { eventId @id }` insert with `ON CONFLICT DO NOTHING`. A redelivery finds the
  key taken and returns without repeating the effect.

**Rationale:**
You never need the state change and the external effect to be atomic. You need the *intent to
publish* to be atomic with the state — which is free, because it is the same database — plus an
at-least-once pump and an idempotent sink. Exactly-once **delivery** is a distributed-systems
mirage; every durable pipeline worth respecting (Kafka, SQS, Stripe's webhooks) is at-least-once and
pushes dedup onto the consumer. So exactly-once **effect** is engineered instead, from three
properties that are each individually provable: atomic intent, a DB-decided claim with
publish-then-mark ordering, and DB-decided consumer dedup.

The outbox does not replace BullMQ and is not a queue. It is the **transactional handoff into**
BullMQ (ADR-009), which keeps retry, backoff, delayed jobs, concurrency limits, and the dead-letter
set. Rebuilding those on a polled table is the pg-boss option above, rejected on exactly that basis.

**Trade-offs:**
- Delivery is at-least-once by construction; a consumer that is not idempotent is a bug, not a
  configuration choice.
- Two dedup layers with different strengths: BullMQ's `jobId` collapse is cheap but bounded (it lapses
  the moment a completed job is evicted, and never covers a stall-redelivery), so the authoritative
  guard is always the consumer's database constraint.
- A relay is a process that must be run and watched. Nothing publishes if it is down — events simply
  accumulate as `PENDING`, which is the safe direction, but it is now a thing that can be down.
- Latency is a notification hop plus a claim, not an in-request enqueue. For a bank call settled
  asynchronously anyway, this costs nothing.
- **Known limitation:** the consumer claims before it acts, so a crash between the claim and the
  effect loses that effect. Deliberate — see ADR-015.

**Revisit when:**
- A second, unrelated consumer needs the same events → the payload shape and ADR-014's command style
  are what change, not this mechanism.
- Outbox volume makes a polled claim hot → partition `TransactionOutbox` by `publishStatus` or move
  published rows to an archive table; the claim's index already covers the pending set.
- The engine grows a second service that must react to money movement → re-evaluate CDC, which starts
  paying for its operational weight once the number of consumers exceeds one.

---

## ADR-014: Command-Style Outbox with a Single Consumer, Not Event Fan-Out

**Status:** Accepted
**Date:** Layer 2

**Context:**
An outbox can carry two different things. **Event style**: past-tense facts about an aggregate
(`transfer.completed`, `transfer.reversed`), many per transaction, published for whoever cares —
notifications, analytics, fraud scoring. **Command style**: one "perform this operation" row per
transaction, addressed to exactly one owner. The choice determines the table shape, the dedup
identity, and how much surface the system grows.

**Options Considered:**

| Option | Pro | Con |
|---|---|---|
| Event style + fan-out consumers | Extensible, decoupled, demonstrates an event-driven architecture | BullMQ is a work queue (one job → one worker), not a broker; fan-out would want Kafka/RabbitMQ. Adds consumers with no behaviour to prove |
| **Command style, 1:1 with the transaction** | Matches the actual requirement (one owner: call the bank), DB-enforceable 1:1, fits BullMQ exactly | A second lifecycle event per transaction needs a schema change |

**Decision:** Command style. One outbox row per transaction, enforced by `transactionId @unique`.

**Rationale:**
The async work has a single owner — call the bank — which is a work-queue shape, and BullMQ is a work
queue. Building notification/analytics/fraud consumers would add components without adding a
correctness claim; the reviewer this repo is written for probes whether money moves exactly once
under failure, not how many boxes the diagram has. *More surface area is not more senior.* The depth
this buys instead — reconciliation, failure injection, observability — is where the remaining
correctness story lives.

Recording the rejection is the point: the event-driven fan-out is a design this system could adopt,
described here, and deliberately not built.

**Trade-offs:**
Settlement is a *status update* on the transaction rather than a new event, and a refund is a
separate transaction with its own row. The 1:1 invariant is enforced by the database, so the day a
transaction legitimately needs to emit two events, the constraint fails loudly rather than silently
producing a half-correct history — a schema change and a migration, not a data-corruption incident.
Note that consumer dedup deliberately does **not** depend on this 1:1: it keys on the outbox row id,
which stays correct if the invariant is ever lifted.

**Revisit when:**
- A second independent consumer needs the same facts → flip to event style and re-evaluate the broker
  (ADR-009's revisit conditions), because BullMQ is the wrong tool for real fan-out.
- A transaction needs to emit more than one lifecycle event → drop `transactionId @unique` and add an
  event `type` to the identity.

---

## ADR-015: The Consumer Claims Before It Acts (At-Most-Once at the Bank Boundary)

**Status:** Accepted — the gap it documents is closed by the async bank flow's outbound idempotency key
**Date:** Layer 2

**Context:**
The consumer does two things: record that it handled the event (the dedup claim) and perform the
effect (eventually, the bank call). They are two writes to two systems, so the same crash gap the
outbox exists to manage reappears one boundary further out — and again it cannot be removed, only
pointed.

**Options Considered:**

| Option | Fails toward | Consequence of the failure |
|---|---|---|
| Act, then claim | At-least-once | The effect ran, no key was recorded; a redelivery repeats it — the customer is debited twice |
| **Claim, then act** | At-most-once | The key is recorded, the effect never ran; a redelivery finds the key and skips — the payment is silently missed |

**Decision:** Claim first, then act.

**Rationale:**
ADR-013's rule ("order the writes so the surviving failure is the safe one") applied to a sink with
different properties. The relay could prefer re-delivery because its sink — this consumer — is
idempotent and absorbs a duplicate for free. The bank is **not** idempotent. A duplicate there is
customer money moved twice: immediately visible, and unwindable only by a compensating reversal. A
missed payment is invisible to the customer and recoverable by reconciliation, which this system is
going to have anyway. Near money, prefer the recoverable failure.

**Trade-offs:**
Exactly-once *effect* is **not** claimed at this boundary, and this is stated rather than hidden: the
outbox delivers at-most-once effect with no duplicates. A secondary consequence is that BullMQ's
consumer-side `attempts` only protect failures *before* the claim commits — an effect that throws is
not retried, because the retry finds its own claim already recorded.

**Revisit when:**
The async bank flow lands: an **outbound** `Idempotency-Key` on the bank call makes a retry return the
original result instead of paying twice, at which point the trade-off dissolves and the shape becomes
a request-state machine — record `PENDING` + the key *before* the call, call, record the outcome
*after*. A crash then leaves an in-doubt row that reconciliation re-drives with the *same* key, and
`IdempotencyJobRecord` grows from a boolean "seen" into a status record. (An idempotent *inbound*
webhook handler dedupes the bank's callbacks to us and is also required — it does nothing about our
own duplicate outbound call. Only the outbound key does.)
