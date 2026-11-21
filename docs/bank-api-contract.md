# Bank ↔ Payments Engine — API Contract

**Version 1.0** · Two parties: the **engine** (this repository, the PSP side) and the **bank**
(`apps/mock-bank`). Two directions: engine → bank (submit, query) and bank → engine (callback).

Modelled on ISO 20022 / SEPA, Nacha ACH, and the webhook conventions of Stripe, Adyen, and
GoCardless. Each term states its reason. Terms are normative unless a section is marked
non-normative; deviations of the current implementation are listed in Appendix B.

---

## 0. Vocabulary

Two terms are defined separately because they are independent.

| Term          | Applies to         | Means                                                                |
| ------------- | ------------------ | -------------------------------------------------------------------- |
| **Final**     | a transfer's state | no outgoing transitions; the transfer will not change again          |
| **Retryable** | an error response  | sending the identical request again could produce a different result |

A transfer reaches a **final** state only through a recorded state transition, reported by callback
(§3.3) — never through an error response. A **retryable** error usually means the transfer has no
state yet (a timeout — the bank may never have received it). The two are never conflated.

Two different retry questions follow from this:

|                     | Question                                                 | Decided by                     | Section |
| ------------------- | -------------------------------------------------------- | ------------------------------ | ------- |
| **Transport retry** | Is this HTTP request sent again, now?                    | the engine's worker            | §5.2    |
| **Business retry**  | Could this transfer succeed if attempted afresh later?   | a human or a scheduled process | §5.3    |

Insufficient funds is **not transport-retryable** — resending changes nothing — but **is
business-retryable**, because the account may be funded later. The two are different actions, taken
by different components at different times, and Section 5 keeps them apart.

---

## 1. Scope

**In scope**

- Submitting one bank transfer (deposit or withdrawal) and learning its outcome
- Querying a submitted transfer, so that an in-doubt outcome can be resolved without inference
- Receiving returns initiated by the bank

**Out of scope** — excluded by decision

- Reconciliation and settlement files (a separate channel by design; §10)
- Recalls initiated by the engine (§6.4)
- Balance enquiry, account validation, statements
- **Customer accounts at the bank.** The bank models no account to debit or credit, so a transfer
  carries neither an account handle nor a direction. Both would require customer onboarding at the
  bank to carry meaning, and neither affects what the engine must get right (§3.1)
- FX and multi-currency (§7)
- Batching — one transfer per request
- Rate limiting
- API versioning (§9)

---

## 2. Transport & Authentication

### 2.1 Transport

|              |                                                     |
| ------------ | --------------------------------------------------- |
| Protocol     | HTTP/1.1, JSON bodies, UTF-8                        |
| Content-Type | `application/json` on every request with a body     |
| Base URLs    | configured per environment; never hard-coded        |

### 2.2 Authentication — HMAC-SHA256, both directions

Requests in both directions are authenticated by HMAC-SHA256 over a shared secret — the scheme used
by Stripe, Adyen, GitHub, and Slack for webhooks. It requires no PKI and no certificate rotation,
which suits two services operated by the same party.

**One secret per direction**: `ENGINE_TO_BANK_SECRET` signs submits and queries, and
`BANK_TO_ENGINE_SECRET` signs callbacks. Each party holds both — one to sign, one to verify. A single
secret would let a leak in one direction forge traffic in the other.

**Header**, on every request in both directions:

```
X-Signature: t=1756900000,v1=5257a869e7bcf5a8b9a1c...
```

| Element | Meaning                                                           |
| ------- | ----------------------------------------------------------------- |
| `t`     | Unix seconds at which the request was signed                      |
| `v1`    | hex HMAC-SHA256, version-prefixed so the scheme can change later  |

**Signed material** — the timestamp, the method and path, and the raw body:

```
signed_payload = "{t}.{METHOD}{path}.{raw_request_body}"
signature      = HMAC_SHA256(secret, signed_payload)
```

| Element            | Definition                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `METHOD`           | the HTTP method, upper case: `POST`, `GET`                                                  |
| `path`             | the request target as sent, without scheme or host, including `/api/v1` and any query string |
| `raw_request_body` | the exact bytes transmitted; a request without a body signs as the empty string             |

For example, a query signs `1756900000.GET/api/v1/transfer/3a7b1f90-….` — the method joined
directly to the path, which always begins with `/`, then a period and an empty body.

**Rationale for signing the timestamp.** A signature over the body alone establishes who wrote a
message but not when. A captured genuine request could then be replayed indefinitely. With the
timestamp inside the signed material, a replay carries an old `t` and is rejected on age.

**Rationale for signing the method and path.** On a query the body is empty and the reference is in
the path. A signature over the timestamp and body alone would be the same for every query signed in
the same second, and a captured one could be presented, within the tolerance window, against any
other `pspReferenceId`. Signing the target binds each signature to the one resource and action it was
issued for: it cannot be replayed against another reference, nor as another method on the same path.

**Verification** — the receiver performs these steps in this order:

1. Read the **raw bytes** of the body, before any JSON parsing; an absent body is zero bytes
2. Reject if `X-Signature` is missing or malformed → `401 AUTHENTICATION_FAILED`
3. Reject if `|now − t| > 300 s` → `401 SIGNATURE_EXPIRED`
4. Recompute the HMAC over the method and path **as received** and the raw bytes, and compare in
   **constant time**
5. Only then parse the JSON, if there is a body, and rely on any field in it

**Raw bytes.** `JSON.parse` followed by `JSON.stringify` does not reproduce the original byte
sequence — key order, whitespace, and number formatting may all change. The signature is computed and
verified over the exact bytes transmitted, captured before any JSON parser consumes the request body.

**Constant time.** An ordinary string comparison returns at the first differing byte; the timing
difference reveals how much of a guessed signature was correct and makes forgery tractable one byte at
a time.

**Tolerance: 300 seconds** — long enough to absorb clock skew and a slow retry, short enough that a
captured request is useless within minutes. This matches Stripe's default.

**Path as received.** The receiver reads the full request target, not a router-relative one: a
framework that strips its mount prefix (`/api/v1`) yields a different string than the sender signed,
and every request fails.

**Ordering.** Every field in the body is attacker-controlled until step 4 passes. Nothing in it is
parsed, logged, or used for lookup before then, including `pspReferenceId`: an attacker able to
influence logged content gains a foothold even when the request is rejected.

### 2.3 Authentication failure

|                           |                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------- |
| Status                    | `401`                                                                                  |
| Body                      | `{"error":{"code":"AUTHENTICATION_FAILED","message":"signature verification failed"}}` |
| Identical response for    | missing header, malformed header, bad signature, unknown key                           |
| Logged                    | the failure, source address, and timestamp — **never the payload**                     |

Every authentication failure produces the same response, so a probing caller learns nothing about
which part was wrong. `SIGNATURE_EXPIRED` is the one distinguished case, because it is retryable
(§5.2).

---

## 3. Endpoints

### 3.1 `POST /api/v1/transfer` — submit (engine → bank)

**Headers**

| Header                           | Required | Notes |
| -------------------------------- | -------- | ----- |
| `Content-Type: application/json` | yes      |       |
| `X-Signature`                    | yes      | §2.2  |

**Request body**

| Field            | Type           | Required | Notes                         |
| ---------------- | -------------- | -------- | ----------------------------- |
| `pspReferenceId` | uuid           | yes      | the engine's `Transaction.id` |
| `amount`         | decimal string | yes      | `"41.50"`; §7                 |
| `currency`       | ISO 4217       | yes      | `"INR"`; §7                   |

**No `direction` or `accountRef`.** The bank models no customer accounts (§1), so an `accountRef`
would name nothing and a `direction` would act on nothing. Whether a transfer is a deposit or a
withdrawal is a fact of the engine's ledger, held on `Transaction.type`; the callback identifies the
transfer by `pspReferenceId`, so the engine never needs the bank to report the direction. Both fields
return with the flow that requires them.

**Success — `202 Accepted`**

```json
{
  "trackingId": "9f1c2e64-...",
  "pspReferenceId": "3a7b1f90-...",
  "status": "RECEIVED",
  "receivedAt": "2026-09-03T10:15:30.000Z"
}
```

A `202` states that the bank has validated and durably recorded the instruction (ISO 20022 `ACTC`) and
will report the outcome later. **No money has moved and nothing has been decided** — a `202` is not a
commitment that the transfer will succeed. Every business check runs after acceptance, and its result
is a state transition reported by callback (§5.3). A `200` would imply completion, which is the most
common cause of premature settlement in integrations of this kind.

The response carries `trackingId` so the engine can correlate immediately — before any callback, and
even if no callback arrives.

**Errors:** §5.

### 3.2 `GET /api/v1/transfer/{pspReferenceId}` — query (engine → bank)

The recovery path: the only means of resolving an in-doubt transfer without inference.

**Keyed by the engine's `pspReferenceId`, in the path** — not by the bank's identifier and not by a
body field. The ambiguous case is precisely the one in which the engine never received a `trackingId`,
so a lookup keyed on it would be unusable exactly when needed.

**`200` — found**

```json
{
  "trackingId": "9f1c2e64-...",
  "pspReferenceId": "3a7b1f90-...",
  "type": "TRANSFER",
  "status": "SETTLED",
  "amount": "41.50",
  "currency": "INR",
  "rejectionReason": null,
  "originalTrackingId": null,
  "receivedAt": "2026-09-03T10:15:30.000Z",
  "settledAt": "2026-09-03T10:15:34.000Z"
}
```

The same resource is returned in every state. While the transfer is `RECEIVED`, the fields only an
outcome can supply are `null`:

| Field             | While `RECEIVED` | Once `SETTLED` / `REJECTED`                         |
| ----------------- | ---------------- | --------------------------------------------------- |
| `settledAt`       | `null`           | when the outcome occurred at the bank               |
| `rejectionReason` | `null`           | non-null only when `REJECTED` (§5.3)                |

A record never carries an `eventId`: it describes the transfer's current state, not a delivery
(§3.3). A caller that applies it does so through the same legal-transition rule as a callback (§6.2),
so a query answer and a later callback for the same outcome cannot both take effect.

**`404 TRANSFER_NOT_FOUND`** — the bank holds no record of the reference.

**`500 TRANSFER_STATE_INCONSISTENT`** — the bank cannot vouch for its own record (for example, a final
status with no outcome behind it). It is never answered as `404`: that would read as "never arrived" for a transfer that may
have settled. The caller treats it as unknown and asks again later.

**The distinction between the two is the purpose of the endpoint.** A `404` means the instruction
never arrived and may safely be submitted. A record with `status: REJECTED` means it arrived and was
refused. A timeout leaves the engine unable to tell these apart; conflating them turns an in-doubt
transfer into a double payment or a lost one.

The endpoint returns a single resource, never a collection: `pspReferenceId` is unique at the bank
(§4.1).

### 3.3 `POST /api/v1/webhook/payment` — callback (bank → engine)

**Headers:** `Content-Type: application/json`, `X-Signature` (§2.2).

**Payload**

```json
{
  "eventId": "e4d9a1c7-...",
  "trackingId": "9f1c2e64-...",
  "pspReferenceId": "3a7b1f90-...",
  "type": "TRANSFER",
  "status": "SETTLED",
  "amount": "41.50",
  "currency": "INR",
  "rejectionReason": null,
  "originalTrackingId": null,
  "receivedAt": "2026-09-03T10:15:30.000Z",
  "settledAt": "2026-09-03T10:15:34.000Z"
}
```

| Field               | Type                   | Notes                                                          |
| ------------------- | ---------------------- | -------------------------------------------------------------- |
| `eventId`           | uuid                   | **identifies this delivery**; the deduplication key            |
| `trackingId`         | uuid                   | identifies the transfer record at the bank                     |
| `pspReferenceId`    | uuid                   | the engine's `Transaction.id`                                  |
| `type`              | `TRANSFER` \| `RETURN` | §6.3                                                           |
| `status`            | enum                   | §6.1                                                           |
| `amount`            | decimal string         | **verified against the held amount, never posted** (below)     |
| `rejectionReason`   | enum \| null           | §5.3; non-null only when `status` is `REJECTED`                |
| `originalTrackingId` | uuid \| null           | non-null only when `type` is `RETURN`                          |
| `receivedAt`        | RFC 3339               | when the bank received the instruction — as in the `202` (§3.1) |
| `settledAt`         | RFC 3339               | when this event occurred at the bank, not when it was sent; for `SETTLED`, the settlement time |

**`eventId` and `trackingId` serve different purposes.** `eventId` answers _"has this message been
processed?"_; `trackingId` answers _"which transfer is this about?"_ One transfer produces several
events. Deduplication is on `eventId`. This mirrors Stripe's `evt_` / `pi_` split and removes the
ambiguity between a redelivery and a genuine second event.

**`amount` is verified, never posted.** The engine already holds the amount it put in flight. The
callback's `amount` is checked against it, and a mismatch is a dispute (§5.4), not an instruction.
Posting the callback's amount would let anyone able to reach the endpoint drain a pooled clearing
account.

**Engine response**

| Situation                                              | Status | Bank's action                      |
| ------------------------------------------------------ | ------ | ---------------------------------- |
| Recorded — applied, already applied, or disputed (§5.4) | `200`  | stop delivering                    |
| Malformed body                                         | `400`  | stop delivering — will never parse |
| Authentication failed                                  | `401`  | stop delivering, alert an operator |
| `eventId` already recorded with a different payload    | `422`  | stop delivering, alert an operator — `IDEMPOTENCY_KEY_REUSED`; the bank issued one id for two events (§4.2) |
| Engine unable to record the event                      | `5xx`  | redeliver per §4.2                 |

**`2xx` = durably recorded. `5xx` = not recorded; redeliver. `4xx` = cannot be recorded; redelivery
will not change that.** The status reports durability, never agreement: a callback the engine
records but disputes is still answered `2xx`, because an identical redelivery would meet an identical
dispute, and the dispute is held where an operator can act on it (§5.4).

---

## 4. Idempotency

### 4.1 Outbound (engine → bank)

|                                                |                                                                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Deduplication identity                         | `pspReferenceId` in the request body (§3.1) — the engine's `Transaction.id`, sent verbatim. No separate header exists |
| Required                                       | yes, on `POST /api/v1/transfer`. Absent, empty, or not a uuid → `400 INVALID_REQUEST`                                 |
| Opacity                                        | the bank derives no meaning from the value; its only property is equality                                             |
| Uniqueness                                     | one value per transfer instruction, scoped to the authenticated caller                                                |
| Honoured for                                   | 24 hours from first receipt                                                                                           |
| Applies to                                     | `POST /api/v1/transfer` only — `GET` carries no instruction and is idempotent by nature                               |
| Fingerprint                                    | the validated instruction — every field after `pspReferenceId`, compared by value after normalisation (below)       |
| Repeat — same reference, same fingerprint      | `202`, same body shape, **derived from the accepted record**: `status` is the transfer's current state (§4.1, below). No reprocessing, no new callback |
| Repeat — same reference, different fingerprint | `422 IDEMPOTENCY_KEY_REUSED` — never a silent overwrite                                                               |

**The business reference as identity.** The engine's identifier already meets every requirement of a
key: it is committed before the request exists, travels in the job payload so every redelivery
carries it, is referenced rather than regenerated by the outbox, and is never shared by two different
transfers. A derived value in a header would carry no additional information and would introduce a
state that cannot legitimately occur — header and body disagreeing. Rationale, including the
derivation built and removed: **ADR-017**.

**A header at a second provider.** A transport header becomes necessary when the key can differ from
the business reference, which a provider-specific constraint forces. An ISO 20022 `EndToEndId`, a
Stripe idempotency key, and a UPI RRN are derived under three different constraints, so key minting
belongs to a provider's adapter rather than to the engine. With one provider there is nothing to mint
(ADR-017).

**The fingerprint is the validated instruction, not the bytes.** The reference alone cannot
distinguish a retry from a different request reusing it: without a fingerprint, a second request
carrying the same `pspReferenceId` and a different `amount` would receive the first request's `202`,
and the bank would report acceptance of an instruction it never accepted. The fingerprint therefore
covers every field of the validated instruction, compared by value — `amount` as a decimal, so
`"41.5"` and `"41.50"` are equal. Either form satisfies the term: comparing the validated fields with
the stored record, or hashing a canonical serialisation of them. The comparison covers the whole
validated instruction in one place, so a field added to the request is compared without a second
change.

The fingerprint is deliberately not computed over the raw body. Byte integrity is the signature's
concern (§2.2); idempotency asks whether a request is the *same instruction*, which is a question of
meaning. Two genuine retries of one instruction can differ in bytes — key order, whitespace, number
formatting — if the sender's serialisation changes between attempts. A byte-level fingerprint would
answer such a retry with `422 IDEMPOTENCY_KEY_REUSED`, stopping the worker and leaving an identical
instruction in doubt.

**A reuse is an engine defect, answered `422`.** The engine derives the whole body from the
transaction, so one `pspReferenceId` always produces one body. A mismatch reports an engine defect
that no retry can fix, and the worker stops. `422` matches the status the engine uses for the same
condition on its inbound side.

**Concurrent duplicates need no state of their own.** Two simultaneous requests with the same
`pspReferenceId` are serialised by the unique constraint on it: the second waits on the first's
uncommitted insert, then reads the committed record and answers from it. An "in flight" state would
be unreachable; it becomes necessary only where a response is stored after external work, and submit
performs none.

**The repeat is answered from the record, not replayed from storage.** An accepted reference always
receives `202` — never `200` or another status — with `trackingId`, `pspReferenceId`, and `receivedAt`
unchanged from the first response. `status` reports the transfer's **current** state and may have
advanced past `RECEIVED`. This is safe because the engine treats a `202` as acknowledgement only and
never acts on its `status` (§3.1); every outcome arrives by callback (§5.3). Storing and replaying the
original response verbatim — Stripe's convention — protects a caller that branches on the response;
no caller here does, so it would add stored state for a guarantee nothing relies on. The term is
revisited if a caller ever acts on the `202`'s `status`.

**No new callback on a repeat.** The original request already produced its callback; a second would
carry no new information and would require deduplication of an event that should not exist.

### 4.2 Inbound (bank → engine)

|                          |                                                                               |
| ------------------------ | ----------------------------------------------------------------------------- |
| Deduplication key        | `eventId`                                                                     |
| Delivery guarantee       | **at least once**                                                             |
| Ordering guarantee       | **none**                                                                      |
| Redelivery trigger       | no response, timeout, or `5xx`                                                |
| Redelivery schedule      | 6 attempts: the first at once, then after 10 s, 1 min, 5 min, 30 min, 2 h      |
| On exhaustion            | marked undeliverable and surfaced to an operator; never dropped, never retried indefinitely |
| Engine response deadline | 5 s                                                                           |

**No ordering guarantee is given, irrespective of the current delivery behaviour.** The engine
reaches the same final state whatever order events arrive in. Assumed webhook ordering is the most
common integration defect of this class, and an assumption that is not stated is not tested.

**Identifier issuance** — the term on which the rest of this section depends:

> **Every event receives a fresh `eventId`. A redelivery of an event reuses its `eventId`.
> `trackingId` is stable for the life of a transfer record. A return is a new record with a new
> `trackingId`.**

Under this rule, three cases are distinguished without inference:

| Arrival                                | Identified by                                           |
| -------------------------------------- | ------------------------------------------------------- |
| Redelivery of an event already handled | `eventId` already seen                                  |
| New event about the same transfer      | new `eventId`, same `trackingId`                         |
| Return of a settled transfer           | new `eventId`, new `trackingId`, `originalTrackingId` set |

---

## 5. Error Contract

### 5.1 Envelope

Every non-`2xx` response, in both directions:

```json
{
  "error": {
    "code": "STABLE_STRING",
    "message": "human readable, may change without notice",
    "details": []
  }
}
```

`code` is the interface and never changes meaning. `message` is for humans and **is never parsed**.
The envelope matches the engine's `AppError` shape, giving one error format across the system.

### 5.2 Submit errors

The **Worker** column is the only one on which calling code branches.

| HTTP        | `code`                                  | Worker                          | Reason                                                                                    |
| ----------- | --------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `400`       | `INVALID_REQUEST`                       | **stop**                        | the same bytes will fail again; an engine defect                                          |
| `401`       | `AUTHENTICATION_FAILED`                 | **stop, alert**                 | credentials are wrong; retrying floods an authentication log                              |
| `401`       | `SIGNATURE_EXPIRED`                     | **retry**                       | a fresh signature will pass — usually clock skew                                          |
| `404`       | `TRANSFER_NOT_FOUND`                    | **stop**                        | query only; the instruction never arrived and may be submitted                            |
| `500`       | `TRANSFER_STATE_INCONSISTENT`           | **retry later**                 | query only; the outcome is unknown — never read as `404` (§3.2)                           |
| `422`       | `IDEMPOTENCY_KEY_REUSED`                | **stop, alert**                 | same `pspReferenceId`, different body — the engine built two requests for one transaction |
| `429`       | `RATE_LIMITED`                          | **retry**, honour `Retry-After` | transient by definition                                                                   |
| `500`       | `INTERNAL_ERROR`                        | **retry**                       | a bank-side fault that may clear                                                          |
| `502`/`503` | `UPSTREAM_UNAVAILABLE`                  | **retry**                       | transient by definition                                                                   |
| _(none)_    | timeout / `ECONNREFUSED` / `ECONNRESET` | **retry — in doubt**            | below                                                                                     |

**A `4xx` refuses the request, never the transfer.** No error response carries a business outcome
(§5.3), and none states whether an earlier attempt under the same `pspReferenceId` was accepted.
Authentication is checked before the deduplication lookup (§2.2), so a retry of an accepted transfer
can still receive `401`. The worker stops without recording an outcome; the transfer remains in doubt
until a callback (§3.3) or a query (§3.2) resolves it.

**No response.** Without a status code the transfer may have been fully processed, partially
processed, or never received. A retry is safe only because of §4.1; without it, this case is a double
payment.

**`SIGNATURE_EXPIRED` is distinct from `AUTHENTICATION_FAILED`** despite the shared status: one is
retryable and the other is not, and `401` alone does not separate them. This is why the body carries
a `code` and calling code branches on it rather than on the status.

### 5.3 Rejection reasons

A rejection is reported in the callback when `status` is `REJECTED` — **never as an error response.**
Every rejection, including one the bank could decide on reading the instruction, is a recorded state
transition (`RECEIVED → REJECTED`, §6.2): queryable through §3.2, replayed
consistently on a re-submit (§4.1), and reported through the same channel as every other outcome.
Where the bank performs its checks is its own concern; the engine relies on outcomes arriving one way.

| `rejectionReason`        | ACH | SEPA | Transport retry | Business retry             |
| ------------------------ | --- | ---- | --------------- | -------------------------- |
| `INSUFFICIENT_FUNDS`     | R01 | AM04 | no              | **yes** — funds may arrive |
| `ACCOUNT_CLOSED`         | R02 | AC04 | no              | never                      |
| `ACCOUNT_NOT_FOUND`      | R03 | AC01 | no              | never                      |
| `INVALID_ACCOUNT`        | R04 | AC01 | no              | not without new details    |
| `ACCOUNT_BLOCKED`        | —   | AC06 | no              | **yes** — a block can lift |
| `LIMIT_EXCEEDED`         | —   | AM02 | no              | **yes** — limits reset     |
| `CURRENCY_NOT_SUPPORTED` | —   | AM03 | no              | never                      |

**A rejection is final for its `pspReferenceId`.** `REJECTED` has no outgoing transitions, and a
re-submit under the same reference receives a `202` derived from the existing record (§4.1), not a fresh attempt.

**A business retry is a new transfer**, initiated by a scheduled process or a human, with a new
`pspReferenceId`. It is never a retry of the original, whose reference would return the stored
outcome indefinitely. Insufficient funds is therefore _not_ retryable by the worker and _is_ retryable
by the business; both statements hold.

### 5.4 Callback disputes

A callback that is syntactically valid and correctly signed, but contradicts the engine's records, is
**recorded as a dispute and answered `2xx`** (§3.3). It is never applied.

| Condition                                                  | Dispute reason      |
| ---------------------------------------------------------- | ------------------- |
| `amount` differs from the amount held for the transfer     | `AMOUNT_MISMATCH`   |
| `pspReferenceId` names no transfer the engine holds        | `UNKNOWN_REFERENCE` |
| `status` contradicts a final state the transfer has reached | `STATE_MISMATCH`    |

A callback of `type: RETURN` without `originalTrackingId` is malformed: `400 INVALID_REQUEST`.

Every dispute raises an alert. A correctly signed message that contradicts known state indicates a
bank defect or a compromised secret; both require an operator. A dispute is not answered `4xx`,
because an identical redelivery would meet an identical dispute — the bank would either retry
indefinitely or discard the event, losing the signal on both sides. The dispute is held in the
engine's reconciliation record, where an operator and the reconciliation process can both act on it.
This section is what makes the _verified, never posted_ rule of §3.3 enforceable.

---

## 6. State Model

### 6.1 States

| State        | ISO 20022 | Meaning                                                 | Final?  |
| ------------ | --------- | ------------------------------------------------------- | ------- |
| `RECEIVED`   | `ACTC`    | validated, durably recorded, outcome not yet known      | no      |
| `SETTLED`    | `ACSC`    | money has moved                                         | **yes** |
| `REJECTED`   | `RJCT`    | refused, with a reason; no money moved                  | **yes** |

Each state exists because a party acts differently in it.

- `RECEIVED` covers the whole of the transfer's time at the bank, including its time on the rail
  (`ACSP`). An in-flight state distinct from it would differ only in cancellability, which v1.0 does
  not offer (Appendix A).
- `SETTLED` and `REJECTED` are both final and mutually exclusive.

**Two outcome states are insufficient.** `SUCCESS | FAILED` cannot express _accepted but not yet
settled_, the state in which a transfer spends most of its life. Every real rail separates these —
`ACSP`/`ACSC`, `in_transit`/`paid`, `confirmed`/`paid_out` — because treating "the bank holds it" and
"money has moved" as one event releases money early.

### 6.2 Transitions

```
                 ┌──────────────┐
   submit ──────▶│   RECEIVED   │
                 └──────┬───────┘
                        │
              ┌─────────┴─────────┐
              ▼                   ▼
      ┌──────────────┐    ┌──────────────┐
      │   SETTLED    │    │   REJECTED   │
      └──────────────┘    └──────────────┘
          ▲ final             ▲ final
```

The legal transitions, and only these:

| From         | To                       |
| ------------ | ------------------------ |
| _(submit)_   | `RECEIVED`               |
| `RECEIVED`   | `SETTLED`, `REJECTED`    |
| `SETTLED`    | —                        |
| `REJECTED`   | —                        |

**Order tolerance.** The engine applies a callback only if it is legal from the transfer's current
state. A stale callback — a `RECEIVED` arriving after `SETTLED` — is acknowledged without effect. A
callback that contradicts a final state is a `STATE_MISMATCH` dispute (§5.4). Out-of-order delivery
therefore reaches the correct final state without the engine knowing the delivery order.

### 6.3 Returns

**A final state is never left.** A return does not move `SETTLED` backwards; it is a **new transfer
record** with its own `trackingId`, referring to the original:

```json
{
  "eventId": "b71e...",
  "trackingId": "c88f...",
  "pspReferenceId": "3a7b1f90-...",
  "type": "RETURN",
  "status": "SETTLED",
  "originalTrackingId": "9f1c2e64-...",
  "amount": "41.50",
  "rejectionReason": "ACCOUNT_CLOSED",
  "receivedAt": "2026-09-05T08:59:58.000Z",
  "settledAt": "2026-09-05T09:00:00.000Z"
}
```

| Field               | Role                                         |
| ------------------- | -------------------------------------------- |
| `type: RETURN`      | this record reverses another                 |
| `originalTrackingId` | the record reversed                          |
| `pspReferenceId`    | the same engine transaction as the original  |
| `rejectionReason`   | why the money returned                       |

The original record remains `SETTLED`. This follows ACH and SEPA: the settled entry is not modified,
and the return is a separate entry carrying its own identifier and a reason code. Final states are
never left _and_ returns exist, because a return is a new record rather than a change of state — the
same rule the engine's ledger follows.

**Constraints**

- A return references only a record whose status is `SETTLED`
- A return's `amount` equals the original's — no partial returns (§7)
- A return is never itself returned
- The bank issues no return more than **60 days** after settlement

**The 60-day window is a contract term.** It is what makes a settled transfer eventually final in fact
as well as in state. It follows Nacha's 60-day window for returns of unauthorised consumer debits.

### 6.4 Recalls — out of scope

A **return** is initiated by the receiving side and cannot be refused. A **recall** is initiated by
the sending side (duplicate, fraud, wrong amount) and can be refused, making it a request–response
negotiation with states of its own.

Recalls are outside v1.0. Returns cover the failure modes this system has; recalls correct the
sender's errors and require an approval flow. The distinction is recorded so that its absence reads
as a decision.

---

## 7. Amounts, Currency, Time

|                    |                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------- |
| Amount format      | decimal **string** — never a float, never a JSON number — e.g. `"41.50"`           |
| Precision          | `Decimal(20,2)` on both sides (ADR-005)                                            |
| Currency           | ISO 4217, required on every message carrying an amount. Single currency: `INR`     |
| Timestamps         | RFC 3339, UTC, explicit offset — e.g. `"2026-09-03T10:15:30.000Z"`                 |
| Partial settlement | **not permitted**                                                                  |
| Partial return     | **not permitted**                                                                  |

**Amounts are strings** because JSON numbers are IEEE-754 doubles, and a monetary value that passes
through a double is no longer exact.

**Partial settlement is not permitted.** The bank settles the full amount or rejects the transfer. This
turns every amount mismatch into a dispute (§5.4) rather than a case for the ledger. Permitting
partial settlement would make "settled less than held" a ledger concept in its own right; introducing
it is a new contract version (§9).

**Currency is required although only one exists.** A monetary message without a currency becomes
ambiguous as soon as a second currency exists, by which time it is in persisted history.

**Timestamps are validated as RFC 3339 instants**, not accepted as arbitrary strings.

---

## 8. Timeouts & Limits

| Term                         | Value                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| Submit latency (bank)        | p99 ≤ **500 ms** for `POST /api/v1/transfer`, which records and acknowledges only        |
| Submit timeout (engine)      | **5 s**, wall-clock, covering connection and response (§8.1)                             |
| Submit attempts (engine)     | at most **8** per instruction (§8.2)                                                     |
| Submit backoff (engine)      | exponential from **2 s**, doubling per retry, **50 %** jitter (§8.2)                     |
| Submit retry window (engine) | ends within ~5 minutes of the first attempt; always inside the 24-hour key window (§4.1) |
| Callback response (engine)   | within **5 s**; a slower response is a failure and is redelivered per §4.2               |
| Max request body             | **64 KB**, both directions                                                               |

### 8.1 Submit timeout

The engine abandons a submit that has not completed **5 s** after it began. The limit is wall-clock
and covers connection and response together; a per-socket idle timeout does not satisfy it, since a
response that delivers bytes slowly never becomes idle.

The value is ten times the bank's p99. A timeout below the bank's tail latency produces in-doubt
transfers from requests the bank was about to accept. An abandoned submit is in doubt (§5.2) and is
retried under the same `pspReferenceId`.

### 8.2 Submit retries

The engine retries a submit only for the outcomes §5.2 marks **retry**: no response, `5xx`,
`429 RATE_LIMITED`, and `401 SIGNATURE_EXPIRED`. Every retry carries the same `pspReferenceId` and an
identical body (§4.1).

**Schedule.** The wait before retry _n_ is drawn uniformly from 50 % to 100 % of `2^(n−1) × 2 s`.
Seven retries therefore wait 127–254 s in total; with the per-attempt timeout, the engine stops
retrying within approximately five minutes of the first attempt.

**Window.** The window absorbs transient faults — connection errors, bursts of `5xx`, a deploy or
failover at the bank — and nothing longer. A longer outage is resolved through the query endpoint
(§3.2), not through further retries.

**Jitter.** Instructions that fail during the same outage share a retry count. Without jitter they
return to the bank together when it recovers. Jitter spreads them across the interval; the 50 % floor
preserves a minimum wait for a bank that is shedding load.

**Upper bound.** Every retry falls inside the 24-hour period for which the bank honours a reference
(§4.1). A retry after the bank has discarded the reference is a new instruction, and therefore a
second payment. The retry window is shorter than that period by more than two orders of magnitude.

**Exhaustion.** After the final attempt the engine stops sending the instruction. The outcome remains
unresolved and is settled by callback (§3.3) or by query (§3.2); it is never inferred from the failure
to obtain a response.

**`Retry-After`.** The bank may send `Retry-After` with `429 RATE_LIMITED`; the engine honours it in
place of the §8.2 schedule for that retry.

### 8.3 Reference implementation timing (non-normative)

The mock bank acknowledges a submit as soon as it is recorded. Settlement and callback delivery run as
separate background processes that poll for work about once a second, so an outcome typically follows
the `202` within a few seconds. These are properties of the test counterpart, not terms of this
contract, and no value in §8 derives from them.

---

## 9. Versioning

**Outside v1.0.** Both services deploy together from one repository, so no period exists in which a
newer bank communicates with an older engine.

This holds only while both deploy together. Once they deploy independently, the version moves into
the URL path; the `v1=` prefix in `X-Signature` already allows the signing scheme to change.

---

## 10. Out of Scope

- **Reconciliation and settlement files.** This contract defines the _event_ channel. Reconciliation
  is a separate, periodic channel that exists because event delivery alone is never sufficient; every
  real network provides both.
- Recalls initiated by the engine (§6.4)
- Partial settlement and partial returns (§7)
- Multi-currency and FX
- Batching
- Rate limiting
- API versioning (§9)
- Balance enquiry, account validation, statements

---

## Appendix A — Alternatives considered

| Decision                            | Alternative                                        | Reason for the decision                                                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HMAC shared secret                  | asymmetric signatures                              | no key distribution when one party operates both sides; revisited if the bank is ever operated externally                                                                                           |
| `eventId` separate from `trackingId` | deduplication on `(pspReferenceId, trackingId)`     | the composite works only while one record produces one event, and fails once a record emits two                                                                                                     |
| Three states                        | a `PROCESSING` (`ACSP`) state between `RECEIVED` and `SETTLED` | it would differ from `RECEIVED` only in cancellability, and v1.0 has no cancellation, so no party acts on it. Re-added with cancellation, as `RECEIVED → PROCESSING → SETTLED \| REJECTED`; the engine's exhaustive status mapping fails the build until the new state is mapped |
| Method and path signed              | signing the timestamp and body only                | a query carries its reference in the path and has no body, so a body-only signature would be replayable against any reference within the tolerance window |
| Returns as new records              | a `RETURNED` status on the original                | matches ACH/SEPA and the engine's append-only ledger; a status field would be a mutable summary of immutable facts                                                                                  |
| Rejections only by callback         | a synchronous `422 TRANSFER_REJECTED` at intake    | a synchronous refusal only moves the check earlier, at the cost of a second reporting channel and a second compensation path. Revisited only for a caller that needs the decision synchronously (authorisation-style); even then the error stops the sender and a callback carries the outcome |
| Fingerprint of the validated instruction | SHA-256 of the raw request body                | idempotency concerns meaning and the signature already guarantees the bytes; a byte-level fingerprint refuses genuine retries whose serialisation changed |
| Repeat answered from the record    | replay the stored original response verbatim       | the engine acknowledges a `202` and never branches on its `status`, so verbatim replay would add stored state for no caller; revisited if one appears |
| Disputed callbacks answered `2xx`   | `422` for amount, reference, or state mismatch     | a retry cannot change a dispute; a `4xx` provokes indefinite redelivery or a discarded event, and the dispute is better held in a record an operator can query                                     |
| No partial settlement               | permit partials                                    | makes an amount mismatch a dispute rather than a ledger feature                                                                                                                                     |
| 60-day return window                | a shorter window                                   | follows Nacha; the existence of a bound matters more than its exact value                                                                                                                           |

---

## Appendix B — Known deviations (non-normative)

The current implementation departs from this contract as follows. Each entry is removed when fixed.

| Term                                   | Current behaviour                                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Callback (§3.3)                        | the engine does not yet receive callbacks; the bank marks each event `UNDELIVERABLE` after the engine's `404` |
| `Retry-After` honoured (§8.2)          | the engine applies the §8.2 schedule regardless                                                             |
| Query used for recovery (§3.2, §5.2)   | the bank serves the query; the engine has no client for it yet, so a request it stopped sending is resolved only by a callback |
| Authentication failures logged (§2.3)  | neither side logs a rejected signature                                                                      |
