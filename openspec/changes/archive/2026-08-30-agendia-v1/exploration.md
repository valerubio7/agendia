# Fresh-verify remediation mapping — AgendIA v1

**Date/context:** read-only mapping from fresh `verify-report.md`; no source, test, or task file was edited and no suite was run. This supersedes the initial pre-design exploration for the active remediation todo. All new behavior must first produce a fresh, behavior-specific RED and record SAFETY NET/RED/GREEN/TRIANGULATE/REFACTOR in `docs/tdd-remediation-evidence.md`; that forward-looking evidence does not rewrite historical evidence.

## Dependency-ordered units

### 28. Compose Baileys socket ingress and addressed outbound delivery
- **Blockers remediated:** C1, C2.
- **Dependencies:** 22–23 complete; no new unit dependency.
- **Likely files:** `packages/whatsapp-baileys/src/baileys-gateway.ts`; `apps/whatsapp-manager/src/{index.ts,lifecycle.ts,inbound-handler.ts,outbound-dispatcher.ts}`; `packages/db/src/repositories.ts`; `packages/db/migrations/0016_baileys_ingress_outbound_target.sql`; `tests/contracts/baileys-gateway.contract.test.ts`; `tests/integration/{baileys-manager-persistence.integration.test.ts,message-processing-worker.integration.test.ts}`; `tests/e2e/support/{system.ts,providers.ts}`; `tests/e2e/system-happy-path.spec.ts`; evidence document.
- **Behavioral RED:** a deterministic socket emits `messages.upsert`, yet no persisted inbound/AI job occurs; separately, a generated response must be sent to its conversation `remoteJid`, and the fake must reject an empty or mismatched JID.
- **GREEN scope:** subscribe to `messages.upsert`, translate only supported Baileys messages into `InboundWhatsAppEvent`, and inject that callback through the production manager rather than calling `manager.inbound.handle` in the harness. Carry `remote_jid` from the conversation (preferably returned by `claim_owned_outbound`, rather than duplicating it) through dispatcher/gateway/sendMessage. Make the system provider record and assert its JID.
- **TRIANGULATE:** prove unknown session, group/from-me/media remain ignored at the socket boundary; prove two simultaneous connections deliver only to their own JID and no call can use `""`.
- **Final gates:** focused contract, integration, and `bunx playwright test tests/e2e/system-happy-path.spec.ts --project=system`; then `bun run test`, `bun run lint`, `bun run typecheck`.
- **Estimated authored lines:** 330–390.
- **Risks:** Baileys update shapes vary and may duplicate/batch messages; preserve existing inbox idempotency and do not use sender identity as tenant authority.

### 29. Persist, authorize, expire, and display linking QR codes
- **Blockers remediated:** C3.
- **Dependencies:** unit 22 lifecycle/API baseline; may follow 28 but has no code dependency on it.
- **Likely files:** `packages/db/migrations/0017_whatsapp_link_codes.sql`; `packages/db/src/repositories.ts`; `apps/whatsapp-manager/src/lifecycle.ts`; `apps/api/src/app.ts`; `apps/web/src/{api-client.ts,live-panel.tsx}`; `tests/integration/baileys-manager-persistence.integration.test.ts`; `tests/contracts/web-api-client.contract.test.ts`; `tests/e2e/{system-happy-path.spec.ts,system-failure-isolation.spec.ts}`; evidence document.
- **Behavioral RED:** after an authenticated POST link and QR lifecycle event, authenticated GET link returns 404 instead of a tenant-owned, unexpired code; UI treats that failure as success.
- **GREEN scope:** persist a short-lived QR associated with business and connection, atomically replace it on a new QR, delete/invalidates it on open/logout/error/expiry, expose it only to the owning business via GET with `Cache-Control: no-store`, and render it in the WhatsApp panel. Do not return auth material or QR to admin/cross-tenant callers.
- **TRIANGULATE:** expiry, replacement, post-open invalidation, wrong tenant/role, and response `no-store`; system E2E must visibly obtain QR before deterministic open rather than auto-open hiding it.
- **Final gates:** focused integration/contract/system tests; then `bun run test`, `bun run db:check`, `bun run lint`, `bun run typecheck`, `bun run build`.
- **Estimated authored lines:** 300–370.
- **Risks:** QR is sensitive operational material; use expiry based on database/server time and ensure lifecycle cleanup cannot remove a newer QR.

### 30. Recover durable `ai.generate` outbox events into pg-boss
- **Blockers remediated:** C4 (outbox recovery portion).
- **Dependencies:** unit 23 worker/runtime; unit 28 is not required but should land first to keep message composition coherent.
- **Likely files:** `packages/db/migrations/0018_outbox_dispatch.sql`; `packages/db/src/repositories.ts`; `apps/whatsapp-manager/src/{index.ts,inbound-handler.ts}`; possibly `packages/test-support/src/worker-fixtures.ts`; `tests/integration/message-processing-worker.integration.test.ts`; `tests/e2e/support/system.ts`; `tests/e2e/system-failure-isolation.spec.ts`; evidence document.
- **Behavioral RED:** persist an accepted inbound row while pg-boss publication is unavailable, restart the manager, and observe its unmarked `ai.generate` outbox event never becomes a job; direct `queue.send` masks this defect.
- **GREEN scope:** remove direct publish from `PostgresInboundHandler`; add a manager-owned bounded dispatcher that claims durable outbox payloads, calls pg-boss with stable singleton identity, marks published only after successful enqueue, and drains pre-existing rows on startup/poll. Maintain at-least-once publication with idempotent job processing.
- **TRIANGULATE:** crash/error before publish retains an unpublished row and later produces one effective AI/outbound result; competing dispatchers and duplicate rows/jobs do not produce duplicate outbound commands.
- **Final gates:** focused worker integration and recovery system E2E; then `bun run test`, `bun run db:check`, `bun run lint`, `bun run typecheck`.
- **Estimated authored lines:** 250–330.
- **Risks:** never mark before broker acknowledgement; do not hold a SQL transaction/row lock across pg-boss I/O, and specify retry/claim visibility so a crashed dispatcher is recoverable.

### 31. Generate and persist production conversation-summary updates
- **Blockers remediated:** C4 (summary-writer portion).
- **Dependencies:** unit 30, because summary work should be durably scheduled/processed by the same recovered worker path.
- **Likely files:** `packages/db/migrations/0019_conversation_summary_jobs.sql` only if durable scheduling/state needs schema; `packages/db/src/repositories.ts`; `apps/message-worker/src/{index.ts,ai-job.ts}`; `packages/domain/src/messaging/conversation-context-builder.ts`; `packages/ai-deepseek/src/deepseek-adapter.ts` only if its typed request must support summarization; `tests/integration/message-processing-worker.integration.test.ts`; `tests/contracts/worker-provider.contract.test.ts`; `tests/e2e/system-failure-isolation.spec.ts`; evidence document.
- **Behavioral RED:** a conversation exceeding the configured recent/context budget has no manually inserted `conversation_summaries` row and blocks permanently or never updates its covered-through version.
- **GREEN scope:** define a bounded, tenant-scoped summary job/request; schedule it after inbound persistence when coverage is needed; atomically append a versioned structured summary with its `covered_through` watermark; have context loading consume the latest valid version. Failed summary generation stays safe/silent and remains retryable without deleting raw history.
- **TRIANGULATE:** restart between scheduling and processing; concurrent messages preserve monotonic versions/watermarks; a second tenant/chat cannot enter the summary or context; provider failure does not send a customer response.
- **Final gates:** focused worker-provider contract, integration, recovery E2E; then `bun run test`, `bun run db:check`, `bun run lint`, `bun run typecheck`.
- **Estimated authored lines:** 330–400.
- **Risks:** summary semantics can lose facts; retain all raw messages, bound provider input/output, and avoid making a missing initial summary block short conversations unnecessarily.

### 32. Audit access/lifecycle/send failures and expose admin activity
- **Blockers remediated:** C5.
- **Dependencies:** unit 29 for complete QR/lifecycle transitions; unit 28 for actual outbound failure path.
- **Likely files:** `packages/db/migrations/0020_audit_runtime_events.sql` if platform-login audit policy/grants require it; `packages/db/src/repositories.ts`; `apps/api/src/app.ts`; `apps/whatsapp-manager/src/{lifecycle.ts,outbound-dispatcher.ts}`; `apps/web/src/{api-client.ts,live-panel.tsx}`; `tests/integration/{http-auth-admin-me.integration.test.ts,baileys-manager-persistence.integration.test.ts,message-processing-worker.integration.test.ts}`; `tests/contracts/web-api-client.contract.test.ts`; `tests/e2e/system-failure-isolation.spec.ts`; evidence document.
- **Behavioral RED:** login/logout produce no immutable audit record; QR/open/close/logout/error produces no required audit plus technical event; rejected/ambiguous send lacks a failure audit; admin API returns activity but rendered table omits it.
- **GREEN scope:** append safe audit events for successful/denied access as specified, logout, lifecycle transitions, and `failed`/`delivery_unknown`; retain technical events so the existing trigger projects activity; include formatted `lastTechnicalActivityAt` in the admin table. Preserve no conversation contents, credentials, QR values, or provider errors in event metadata.
- **TRIANGULATE:** tenant and platform-admin access paths, lifecycle failure, both send outcomes, and cross-tenant/admin non-content visibility; confirm activity changes and UI shows it.
- **Final gates:** focused HTTP/manager/worker integration, web contract, failure system E2E; then `bun run test`, `bun run db:check`, `bun run security:scan`, `bun run lint`, `bun run typecheck`, `bun run build`.
- **Estimated authored lines:** 300–380.
- **Risks:** current `appendAudit` takes a non-null business ID while platform login has none; resolve platform audit explicitly without weakening append-only/RLS or inventing tenant ownership.

### 33. Replace syntactic traceability with semantic acceptance evidence
- **Blockers remediated:** C6; validates C1–C5 after their units land.
- **Dependencies:** units 28–32.
- **Likely files:** `tests/e2e/support/{system.ts,providers.ts}`; `tests/e2e/{system-happy-path.spec.ts,system-failure-isolation.spec.ts}`; `tests/contracts/web-api-client.contract.test.ts`; `tests/acceptance/remediation-traceability.acceptance.test.ts`; `packages/test-support/src/v1-traceability.ts`; `docs/acceptance.md`; `docs/tdd-remediation-evidence.md`.
- **Behavioral RED:** acceptance validation passes when a mapped system test bypasses socket ingress, a provider fake accepts an empty JID, or QR `NOT_FOUND` is claimed as linking success.
- **GREEN scope:** make tests assert provider-boundary effects introduced in 28–32; map each requirement/scenario to a test whose named assertion exercises that behavior, rather than broad happy-path string references. Strengthen the validator only for objective evidence metadata (named behavioral assertion, layer, provider-boundary declaration, focused command); do not claim static inspection proves semantics.
- **TRIANGULATE:** deliberately relabel a direct-handler test as socket ingress, tolerate an empty JID, and map QR failure as success; each must make the acceptance validator fail. Keep historical renderer harnesses explicitly non-system evidence.
- **Final gates:** `bun run test:acceptance`, focused system E2E, then `bun run test`, `bun run test:e2e`, `bun run db:check`, `bun run scope:check`, `bun run security:scan`, `bun run lint`, `bun run typecheck`, `bun run build`.
- **Estimated authored lines:** 250–360.
- **Risks:** metadata checks cannot substitute for test review; avoid an unmaintainable one-test-per-ID rule where one genuinely semantic scenario test covers a requirement.

### 34. Record strict-TDD provenance truthfully; seek policy disposition
- **Blockers assessed:** C7 only.
- **Dependencies:** none; it should be recorded before claiming remediation complete, while new units still add their own fresh evidence.
- **Likely files:** `openspec/changes/agendia-v1/tasks.md` (append a non-checkbox decision/follow-up, not a false completion); `docs/tdd-remediation-evidence.md`; `openspec/changes/agendia-v1/verify-report.md` only on the next independent verify; optionally `openspec/config.yaml` only if the governing strict-TDD policy owner explicitly changes policy.
- **Behavioral RED/GREEN/TRIANGULATE:** **not applicable to historical provenance.** Fresh behavioral REDs for units 28–33 are required and can be recorded, but cannot become RED/SAFETY NET evidence for units 1–18 or retroactively repair units 22, 24, or 25.
- **Closure scope:** state the missing historical evidence and the reason; preserve observed current GREEN separately; request an explicit policy-owner waiver/re-baselining decision or leave C7 failed. Never manufacture timestamps, failing output, or claim that a build/type failure was a behavioral RED.
- **Final gates:** no test can verify absent historical execution. On a policy disposition, independently rerun verification and report either an authorized exception or C7 failure; do not label it PASS merely because current tests are green.
- **Estimated authored lines:** 30–80 documentation only.
- **Risks:** any attempt to add retrospective table rows as evidence would be fabrication and violates strict TDD.

## C7 conclusion

C7 cannot be truthfully remediated under the current strict-TDD rule by code or newly executed tests: the required historical RED and per-task SAFETY NET executions did not occur or were not preserved. The only honest paths are (1) retain C7 as a blocking evidence failure while using fresh complete cycles for remediation units 28–33, or (2) obtain and record an explicit policy-owner waiver/re-baseline that changes archive eligibility without calling historical evidence complete. Unit 34 is therefore governance/provenance work, not a technical fix and must not be checked off as a C7 pass absent that explicit disposition.

## Work-unit boundary

Each unit keeps tests and documentation with its production behavior, forecasts at most 400 authored lines, and has a standalone focused verification command. Units 28–32 should be landed serially because they alter the same production composition; unit 33 follows all behavior changes. No broad suite was run during this exploration.
