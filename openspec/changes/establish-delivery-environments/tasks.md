# Tasks: Establish Delivery Environments

## Review Workload Forecast

| Field | Value |
| ------- | ------- |
| Estimated changed lines | 2,800–4,500 total across 35–50 files |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | P0 decision → PR 1 lint → PR 2 manifest → PR 3 packaging → PR 4 read-only contract → PR 5 config → PR 6 isolation preflight → PR 7 health → PR 8 Compose → PR 9 roles/queue → PR 10 migration ledger → PR 11 CI → PR 12 governance → PR 13 deployctl → PR 14 backup → PR 15 restore → PR 16 runbooks → PR 17 integral simulation |
| Delivery strategy | exception-ok |
| Chain strategy | not applicable (`size:exception`) |

Decision needed before apply: No — the user explicitly accepted `size:exception`.
Chained PRs recommended: Yes, but declined by explicit user decision.
Chain strategy: not applicable
400-line budget risk: High — explicitly accepted.

**Apply authorization:** P0 remains the first blocking implementation decision. The user explicitly accepted `size:exception`, so implementation may proceed as one oversized delivery change while still executing and verifying the 18 tasks sequentially. This exception does not relax strict TDD, dependency gates, external human gates, or ordinary repository review policy.

## Implementation sequence

All estimates are additions plus deletions for one autonomous PR. Every PR keeps its tests and any required documentation with the code it verifies; each is independently revertible by reverting that PR. Use strict TDD in every unit: commit the focused RED test, implement the smallest GREEN change, add the stated TRIANGULATE case, then REFACTOR with the named focused verification.

### P0 — Packaging decision (200–330 lines; 4–7 files; no downstream packaging dependency may start)

- [x] At `tests/e2e/release-image*`, focused release-build helpers, and versioned `deploy/packaging-decision.json`, prove or reject universal-image feasibility on clean linux/amd64 with frozen Bun 1.4.0: bundle workspace entrypoints, load `@node-rs/argon2`, exercise Baileys dynamic assets/socket double, publish/consume pg-boss against ephemeral PostgreSQL, build Next standalone with `/api` (read-only) rewrite, and consecutively start web/API/manager/worker from generated output without checkout sources, `tsx`, or `next dev`; repeat with read-only root and declared writable mounts. **RED:** omit a native/dynamic/static asset and show the focused contract fails. **GREEN:** add only localized tracing/copy/entrypoint changes. **TRIANGULATE:** prove manager+worker and web+API independently plus denied writes. **REFACTOR:** extract fixture helpers; run `bun run test:contracts`, `bun run test:integration`, `bun run typecheck`, and `bun run build`. Record `universal-image` only if all checks pass; otherwise record `release-set` and cause. <!-- sdd-owner: implementation -->

### PR 1 — Lint prerequisite (40–70 lines; 2–3 files; depends on P0 evidence only)

- [x] At `package.json`, the selected lint configuration, and `tests/contracts/lint*`, add the missing locked `bun run lint` contract. **RED:** capture the absent/invalid command and a known violation. **GREEN:** add the minimum Bun/TypeScript-compatible script/configuration. **TRIANGULATE:** prove TypeScript and one config/workflow/script surface are checked rather than ignored. **REFACTOR:** centralize rules/ignores; run `bun run lint`, `bun run typecheck`, and `bun run test:unit`. <!-- sdd-owner: implementation -->

### PR 2 — Immutable release manifest (90–150 lines; 2–4 files; depends on PR 1)

- [x] At `deploy/release-manifest.schema.json` or its TypeScript equivalent and `tests/contracts/release-manifest*`, implement the discriminated digest contract for `universal-image` and `release-set`, `linux/amd64`, commit, compatibility, and immutable `@sha256` references. **RED:** reject a tag, wrong platform, missing/extra process, mixed image set, and altered linked digest. **GREEN:** add the minimal validator and canonical serialization. **TRIANGULATE:** accept both artifact kinds regardless of P0 result and reject an attestation/Compose disagreement fixture. **REFACTOR:** share digest parsing; run `bun run test:contracts`, `bun run lint`, `bun run typecheck`, and `bun run build`. <!-- sdd-owner: implementation -->

### PR 3 — P0-selected release packaging (200–320 lines; 3–6 files; depends on P0 and PR 2)

- [x] At `Dockerfile`/bounded process Dockerfiles, `.dockerignore`, release dispatcher/build helpers, and `deploy/images.lock`, implement only the P0-selected artifact: universal image when P0 is green, otherwise the bounded release-set and manifest assembly. **RED:** show an unpinned base or runtime source/`tsx`/`next dev` layout fails. **GREEN:** pin bases, run as UID/GID 10001, exclude toolchain/tests/secrets/sources, and start each supported command from generated output. **TRIANGULATE:** prove API/manager/worker native loading and Next standalone separately. **REFACTOR:** deduplicate build/entrypoint logic; run `bun run test:contracts`, `bun run test:integration`, `bun run lint`, `bun run typecheck`, and `bun run build`. <!-- sdd-owner: implementation -->

### PR 4 — Read-only runtime contract (120–200 lines; 2–4 files; depends on PR 3)

- [x] At `tests/e2e/release-image-readonly*` and the selected packaging/entrypoint surfaces, enforce the four-command read-only-root contract with ephemeral PostgreSQL, no provider egress, exact tmpfs paths, meaningful readiness/work, denied writes to `/opt/agendia` (read-only), `/etc` (read-only), and sibling paths, and restart independence from tmpfs. **RED:** fail on an undeclared mount or forbidden write. **GREEN:** add only required HOME/mount setup. **TRIANGULATE:** cover all four commands and each applicable selected artifact. **REFACTOR:** consolidate container harness setup; run `bun run test:contracts`, `bun run test:e2e`, `bun run lint`, `bun run typecheck`, and `bun run build`. <!-- sdd-owner: implementation -->

### PR 5 — Runtime configuration and secret files (150–260 lines; 3–5 files; depends on PR 2)

- [x] At `packages/runtime-config/**`, `deploy/config/*.example.env`, four process entrypoints, and `tests/unit/runtime-config*`, add centralized per-process configuration and safe `_FILE` loading. **RED:** reject absent files, inline unsafe secrets, malformed digest/origin, and secret-bearing errors. **GREEN:** implement the minimum Zod loader requiring process/environment/release identity and process-specific DB URL files while rejecting generic release `DATABASE_URL`. **TRIANGULATE:** validate API, manager, worker, web, and one-shot variants with valid file-backed values. **REFACTOR:** share parsing/redaction; run `bun run test:unit`, `bun run test:contracts`, `bun run lint`, and `bun run typecheck`. <!-- sdd-owner: implementation -->

### PR 6 — Cross-environment preflight (120–200 lines; 2–4 files; depends on PR 5)

- [x] At `packages/runtime-config/**`, DB marker migration/schema targets, and `tests/integration/*environment*`, reject crossed environment ID, DB host/name/login prefix, secret-set/hash, and staging E.164 identity manifests before readiness, listening, sessions, or worker activity. **RED:** cover crossed DB URLs, equal critical-secret hashes, and a production number in staging. **GREEN:** add fail-closed marker/preflight checks without revealing values. **TRIANGULATE:** exercise API, manager, and worker against valid isolated and invalid crossed markers. **REFACTOR:** centralize codes/reporting; run `bun run test:unit`, `bun run test:integration`, `bun run test:tenant-isolation`, `bun run lint`, and `bun run typecheck`. <!-- sdd-owner: implementation -->

### PR 7 — Health, heartbeat, logs, shutdown (160–270 lines; 3–5 files; depends on PR 5)

- [x] At existing health/logger/signal modules, `agendia_service_heartbeats` migration targets, and focused unit/integration tests, add web/API live-ready, loopback-only manager/worker probes, 30-second durable heartbeat, coded readiness reasons, redacted JSON logs, and controlled drain/lock release. **RED:** cover stale heartbeat, healthy idle worker, missing marker, SIGTERM drain, and a secret/JID/QR in log payload. **GREEN:** implement minimal probes, writer, handlers, and redactor. **TRIANGULATE:** prove every process and provider-independent liveness. **REFACTOR:** share probe/log contracts; run `bun run test:unit`, `bun run test:integration`, `bun run test:contracts`, `bun run lint`, and `bun run typecheck`. <!-- sdd-owner: implementation -->

### PR 8 — Compose isolation and capacity policy (180–300 lines; 3–5 files; depends on P0, PR 2, PR 4, PR 6, and PR 7)

- [x] At `deploy/compose.yml`, bounded environment templates/cloudflared templates, teardown wrapper targets, and `tests/contracts/compose*`, define literal `agendia-prod`/`agendia-stg` networks, binds, labels, fixed digests, no host ports, hardening/tmpfs/resource/log/restart policies, staging capacity exclusions, and safe staging-only teardown. **RED:** reject tags, ports, shared paths, missing labels, and a teardown candidate containing `prod`. **GREEN:** implement minimum Compose/render/teardown behavior consuming the selected P0 representation. **TRIANGULATE:** render both environments and prove staging destruction preserves production IDs/checksums. **REFACTOR:** factor shared templates without weakening literal assertions; run `bun run test:contracts`, `bun run test:integration`, `bun run lint`, `bun run typecheck`, and `bun run build`. <!-- sdd-owner: implementation -->

### PR 9 — Database roles and queue initialization (160–270 lines; 3–5 files; depends on PR 6)

- [x] At role-provisioning SQL/scripts, `queue-init` command targets, and `tests/integration/*roles*`/`*queue-init*`, create scoped cluster-admin, migrator, API, manager, queue-publisher, worker, queue-owner, and backup roles with runtime DDL denied and pg-boss queues initialized exactly once. **RED:** prove runtime logins cannot DDL/cross capability boundaries and pg-boss cannot initialize implicitly. **GREEN:** implement idempotent separate-credential `provision-roles` and `queue-init`. **TRIANGULATE:** cover both environment naming schemes and manager publisher versus worker consumer grants. **REFACTOR:** consolidate auditable grant builders; run `bun run test:integration`, `bun run test:contracts`, `bun run db:check`, `bun run lint`, and `bun run typecheck`. <!-- sdd-owner: implementation -->

### PR 10 — Governed migrations (190–330 lines; 3–5 files; depends on PR 2, PR 6, and PR 9)

- [x] At migration/ledger tables, the `migrate` one-shot target, compatibility manifest validation, and migration integration tests, implement finite advisory lock, marker and backup-evidence preflight, transactional checksums, existing-schema baseline, explicit compatibility modes, and no normal-startup migration. **RED:** reject changed historical SQL, lock contention, unledgered drift, missing backup evidence, and incompatible rollback. **GREEN:** implement the minimal algorithm and JSON evidence. **TRIANGULATE:** distinguish clean versus existing-schema baseline and both compatibility modes. **REFACTOR:** isolate inspection/ledger functions; run `bun run test:integration`, `bun run test:contracts`, `bun run db:check`, `bun run lint`, `bun run typecheck`, and `bun run build`. <!-- sdd-owner: implementation -->

### PR 11 — CI and release evidence (200–320 lines; 3–5 files; depends on PR 1–4 and PR 10)

- [x] At `.github/workflows/ci.yml`, `release.yml`, release verification helpers, centralized PostgreSQL image lock target, and workflow fixtures, run configured suites, exact-SHA merged-PR checks, selected amd64 build/read-only contract, scan policy, GHCR publication, SPDX SBOM, provenance, and immutable release evidence. **RED:** reject missing lint, tag-only identity, failed check, unmerged/no-PR SHA, unpinned PostgreSQL, and unapproved HIGH exception. **GREEN:** implement least-privilege workflow/verifier. **TRIANGULATE:** test both P0 artifact modes and PR/main triggers without secrets. **REFACTOR:** deduplicate validation steps; run `bun run test:contracts`, `bun run lint`, `bun run typecheck`, and `bun run build`. <!-- sdd-owner: implementation -->

### PR 12 — SOLO PILOT authorization (110–180 lines; 2–4 files; depends on PR 2 and PR 11)

- [x] At `.github/CODEOWNERS`, `authorize-promotion.yml`, governance matrix/runbook source, and authorization contract tests, implement manual same-digest staging then production authorization with truthful GitHub-plan fallback; keep MULTI-MAINTAINER controls documented but inactive. **RED:** reject missing staging evidence, digest mismatch, absent check, and claims of unavailable controls. **GREEN:** add minimum SOLO authorization manifest/checks without fictitious reviewers. **TRIANGULATE:** cover Environment available/unavailable paths and reject MULTI-only enforcement in SOLO mode. **REFACTOR:** centralize evidence schema; run `bun run test:contracts`, `bun run lint`, and `bun run typecheck`. <!-- sdd-owner: implementation -->

### PR 13 — Pull-based deployctl (190–300 lines; 3–5 files; depends on PR 8, PR 10, PR 11, and PR 12)

- [x] At `scripts/deployctl.ts` and deployctl contract tests, accept only authorized digest identities; validate manifest/provenance/SBOM/platform/Compose, pull bound digests, atomically switch current/previous release files, enforce capacity/migration/restore/backlog gates, and forbid production destroy, checkout copy, or GitHub-to-host contact. **RED:** reject mutable tags, wrong platform, mixed sets, absent authorization, failed gates, and production destroy. **GREEN:** implement minimal parser/preflight/switch/rollback. **TRIANGULATE:** cover universal and release-set resolution and same-digest staging-to-production promotion. **REFACTOR:** isolate filesystem/Compose adapters; run `bun run test:unit`, `bun run test:contracts`, `bun run lint`, `bun run typecheck`, and `bun run build`. <!-- sdd-owner: implementation -->

### PR 14 — Backup artifacts (200–290 lines; 3–5 files; depends on PR 6 and PR 10)

- [x] At `scripts/backup-production.ts`, backup evidence schema, `deploy/systemd/*`, secure config examples, and unit/integration tests, implement provider-agnostic restic/age backup orchestration using only an ephemeral local test repository. **RED:** reject local/same-PC destination, missing age recipient, stale/failed snapshot, and secret-leaking evidence. **GREEN:** create consistent dump, encrypted key bundle, release/schema evidence, retention/check scheduling, cleanup, and fail-closed gates. **TRIANGULATE:** parse SFTP/S3-style configuration without credentials and cover historical key versions. **REFACTOR:** share secure command/evidence helpers; run `bun run test:unit`, `bun run test:integration`, `bun run test:contracts`, `bun run lint`, and `bun run typecheck`. This does not configure a real destination or credentials. <!-- sdd-owner: implementation -->

### PR 15 — Isolated restore drill (170–260 lines; 2–4 files; depends on PR 14)

- [x] At `scripts/restore-drill.ts`, backup evidence schema, and Testcontainers restore contracts, restore only to an `agendia-restore-*` isolated project/volume; verify fingerprint/RLS/jobs, historical KEK/QR availability without plaintext logs, RPO/RTO JSON, and labeled teardown. **RED:** reject missing historical key, staging/production mount reuse, malformed evidence, and failed `pg_restore`. **GREEN:** implement the minimum isolated drill/evidence generator. **TRIANGULATE:** cover multiple key versions, snapshot dates, and compatibility modes. **REFACTOR:** share labels/evidence validation with backup/deployctl; run `bun run test:integration`, `bun run test:contracts`, `bun run db:check`, `bun run lint`, and `bun run typecheck`. This does not execute an external restore drill. <!-- sdd-owner: implementation -->

### PR 16 — Operational runbooks (100–150 lines; 2–4 files; depends on PR 8, PR 10, PR 13, PR 14, and PR 15)

- [ ] At `docs/runbooks/{host-provisioning,deploy,staging-window,backup-restore,rollback,disaster-recovery,host-health}.md` and documentation contract tests, distinguish repository artifacts, host provisioning, promotion, application rollback, data recovery, full reconstruction, staging capacity, and deferred external gates using precheck → proposed command → verification → rollback guidance. **RED:** reject missing sections, unsafe port forwarding, or conflated application/data rollback. **GREEN:** add concise runbooks and explicit human approval points. **TRIANGULATE:** cover universal/release-set instructions and SOLO/MULTI distinctions. **REFACTOR:** normalize terminology/links; run `bun run test:contracts`, `bun run lint`, and `bun run typecheck`. <!-- sdd-owner: implementation -->

### PR 17 — Repository-only integral simulation (200–300 lines; 3–5 files; depends on PR 8–16)

- [ ] At `tests/e2e/release-promotion*` and bounded verification helpers, simulate ephemeral Compose/Testcontainers staging and same-digest production promotion: selected identity, isolated config/secrets/roles/volumes, migrate then queue-init, four readiness/heartbeat checks, private smoke, evidence, safe teardown, and rollback compatibility. **RED:** fail a cross-environment resource or changed-digest promotion. **GREEN:** add only missing orchestration. **TRIANGULATE:** exercise selected behavior plus fallback fixture resolution and preservation of production IDs. **REFACTOR:** remove duplicate harness setup; run `bun run lint`, `bun run typecheck`, `bun run test:unit`, `bun run test:integration`, `bun run test:contracts`, `bun run test:tenant-isolation`, `bun run test:e2e`, `bun run test`, `bun run db:check`, and `bun run build`. No real host, Cloudflare, DNS, secrets, WhatsApp number, or external backup destination is used. <!-- sdd-owner: implementation -->

## Deferred human-operated gates

These are blocking external/manual actions, not implementation checkboxes: Cloudflare account/tunnel identities/domain/zone/DNS/Access policy and verified HTTPS origin; external restic destination, real credentials, custodians, and external restore drill; approved host provisioning and real storage/network/resource baseline; distinct real production/staging secrets, logins, WhatsApp identities, provider credentials, bootstrap material, and historical keyrings; written Wi-Fi/no-UPS risk acceptance and authorization to admit real users.

## Parent lifecycle actions (after implementation work)

- [x] Record the user's explicit `size:exception` acceptance; use delivery strategy `exception-ok` with no chain strategy. <!-- sdd-owner: parent -->
- [ ] Confirm authorized humans have supplied external-gate evidence before real-user enablement; repository tests, placeholders, and runbooks are not completion. <!-- sdd-owner: parent -->
