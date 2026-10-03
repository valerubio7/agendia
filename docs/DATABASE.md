# Persisted WhatsApp reply pacing

WhatsApp replies use the existing PostgreSQL outbox and pg-boss queue. Migration
`0021_whatsapp_reply_pacing.sql` adds conversation state, not a scheduler or table.
No business-hours gate is applied.

## Deadline policy

| Situation | Wait |
|---|---|
| No successfully sent reply yet | 600 seconds |
| Conversation with a sent reply and activity within one hour | 90 seconds |
| Return strictly more than one hour after the latest accepted inbound or successful outbound | 600 seconds |
| Additional inbound in an open burst | Keep the original deadline |

Accepted activity uses database time rather than an untrusted provider timestamp.
Exactly one hour remains active. Generation, failure and `delivery_unknown` do not
count as a successfully sent reply. Duplicate provider IDs do not affect activity.

`conversations.reply_due_at` holds the open burst deadline; `latest_inbound_id`
identifies its current source. `last_exchange_at` and `last_reply_at` retain the
activity boundary and whether a reply has actually been sent. Each latest source
has an `outbox_events.next_attempt_at` deadline. The existing dispatcher publishes
only eligible events, so a process restart does not erase a wait.

## Concurrency and delivery cutoff

1. Ingestion locks the conversation row, preserves the burst deadline, replaces
   the latest source and supersedes older pending/generated work atomically.
2. Generation checks latest-source identity and eligibility after acquiring its
   conversation advisory lock. Lock contention waits without holding a pooled
   connection; it does not acknowledge and discard the latest job.
3. Saving generated text locks the same conversation row, then checks freshness
   again before creating a source-linked outbound command.
4. Outbound claim locks that row and rechecks source identity and deadline in a
   fresh SQL statement before changing one command to `sending`. Claim closes
   the burst. Source-less legacy commands are compatible only when no burst is
   open; otherwise they are marked `failed` / `superseded` before claiming fresh
   output. New accepted input also supersedes these unknown-source commands.
   This prevents an old command from consuming a newer group's deadline or
   becoming eligible again after that group closes.

The atomic outgoing claim is the cutoff: accepted messages can invalidate unsent
commands but cannot retract a provider send already in flight. Successful sends
update activity under the same row lock. `delivery_unknown` remains terminal and
is never blindly retried. Raw inbound history remains ordered even when its old
job is superseded, so the latest generation sees the complete burst context.
Tenant-scoped repository transactions and tenant/business join predicates remain
in force; the owner-scoped claim is the existing privileged manager boundary.

## Upgrade and verification

The migration backfills activity and latest-source identity from existing history.
Accepted inbound times come from server-written outbox creation times, not inbound
provider `received_at`. Confirmed outbound `received_at` was written by the database
worker. The pending burst opens at its first pending inbound, and its delay uses
only activity and sent replies preceding that opener in conversation sequence.
Exactly one hour is active; a greater gap or no preceding sent reply is initial.
Later pending messages preserve the opener's deadline rather than masking its gap.

Pending pre-migration groups receive that persisted deadline and a fresh outbox
key, so an already-published early job cannot consume their only durable wake-up.
Old non-latest events may publish early, but the worker suppresses their provider
calls. Superseded messages, outbox events and commands remain recorded, not deleted.

Deterministic coverage lives in `tests/unit/reply-pacing.test.ts` and
`tests/integration/message-processing-worker.integration.test.ts`. Populated
upgrade coverage in `tests/integration/whatsapp-reply-pacing-upgrade.integration.test.ts`
applies migrations through 0020, seeds published/unpublished groups, then applies
0021 and exercises restricted manager/worker roles. Tests advance
isolated database deadlines rather than waiting ten minutes, and observe real
PostgreSQL lock contention during generation.
