# Apply Progress: Establish Delivery Environments

## Structured status consumed

- `changeName`: `establish-delivery-environments`
- `artifactStore`: `openspec`; proposal/spec/design/tasks were present; `applyState`: `ready`.
- `actionContext`: `repo-local`, workspace root `/home/valerubio7/Projects/agendia`; every edit stayed inside an allowed surface.
- Delivery decision: `exception-ok` / explicit `size:exception`; this work unit is only `p0-packaging-feasibility`.
- Action-context warnings: none. No host provisioning, commit, push, PR, review actor, or downstream task was started.

## Completed implementation task

- [x] P0 packaging decision; the matching persisted checkbox in `tasks.md` is checked.
- Packaging outcome: **`universal-image`**.
- PR/work-unit boundary: P0 feasibility only. PR 1 and all downstream implementation remain untouched.

## TDD Cycle Evidence

| Task | Test file | Layer | Safety net | RED | GREEN | TRIANGULATE | REFACTOR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P0 | `tests/contracts/release-image-p0.contract.test.ts` | Contract + clean-container integration | 13/13 focused Baileys/worker contracts; baseline build passed after adding Bun to PATH | Missing helper/module failed 0/1; missing native asset exited 1 with `Cannot find native binding`; generated API command exited 0 instead of listening | 4/4 focused tests; native Argon2, deterministic Baileys and pg-boss probes passed from generated output | Manager+worker stayed running; web/API page, static asset and rewrite returned 200/200/401; all nine writable-path probes passed and `/opt/agendia` writes were denied | Layout inspection and runtime probes were extracted; focused 4/4 remained green |

## Exact commands and results

- `bun test tests/contracts/release-image-p0.contract.test.ts` → RED: missing `scripts/release-build-p0.ts`, 0 pass / 1 fail; final GREEN/REFACTOR: 4 pass / 0 fail / 9 assertions.
- `docker run --rm --platform linux/amd64 -v /tmp/agendia-p0-probe-missing:/opt/agendia/probe:ro oven/bun:1.4.0 bun /opt/agendia/probe/runtime-probe.js native` → RED exit 1, missing `argon2.linux-x64-gnu-*.node` / native binding.
- Clean builder used `oven/bun:1.4.0`, `bun install --frozen-lockfile`, then `bun build <entrypoint> --target=bun --outdir <layout/process>` for API, manager, worker and probe, followed by `AGENDIA_API_ORIGIN=http://api:3001 NEXT_TELEMETRY_DISABLED=1 bun run --cwd apps/web build` → pass on `linux/amd64`; 1519 generated files, no `.ts`/`.tsx`, `tsx`, or `next dev` paths.
- `docker run ... --read-only --user 10001:10001 ... bun /opt/agendia/probe/runtime-probe.js native|baileys|queue` → `nativeArgon2=true`, deterministic QR/open/browser, and `pgBoss=published-and-consumed` against ephemeral PostgreSQL 16.
- Generated commands `bun /opt/agendia/{api,whatsapp-manager,message-worker}/index.js` and `bun /opt/agendia/web/server.js` all remained running with read-only roots and only declared tmpfs mounts.
- `bun run test:contracts` → 37 pass / 0 fail.
- `bun run test:integration` → 36 pass / 0 fail.
- `bun run typecheck` → pass.
- `bun run build` → pass; Next standalone build produced 7 static routes.

## Files changed

- `apps/api/src/index.ts` — generated bundle now has a main entrypoint and controlled shutdown.
- `apps/web/next.config.ts` — enables monorepo-root-traced standalone output.
- `deploy/p0/runtime-probe.ts` — native, Baileys-double, pg-boss and denied-write feasibility probe.
- `scripts/release-build-p0.ts` — release commands, mount declaration and layout inspection helpers.
- `tests/contracts/release-image-p0.contract.test.ts` — P0 RED/GREEN/triangulation contract.
- `deploy/packaging-decision.json` — versioned `universal-image` decision, hashes and evidence.
- `openspec/changes/establish-delivery-environments/{tasks.md,apply-progress.md}` — persisted progress.

## Deviations, failures, and limitations

- A clean frozen Bun install did not expose every transitive `workspace:*` package at the builder root; a localized build-stage workspace-link pass made bundling deterministic without runtime sources. Final packaging must retain an equivalent localized linker step.
- Bun emits Argon2 GNU and musl native assets beside importing bundles; omitting them produced the required useful RED.
- Next standalone required localized normalization from its monorepo `apps/web` traced layout and preservation of its generated `node_modules/next` link.
- This is not the final Docker/Compose implementation. The gate used one generated layout mounted read-only into clean amd64 Bun containers.
- No real provider network was used; Baileys behavior and queue work were deterministic.

## Next recommended task

PR 1 has since been completed in the cumulative update below. Parent lifecycle remains responsible for delivery/review actions.

## Remaining exact unchecked task lines
- PR 2 immutable release manifest is complete; its persisted task checkbox is checked in `tasks.md`.
- [ ] At `Dockerfile`/bounded process Dockerfiles, `.dockerignore`, release dispatcher/build helpers, and `deploy/images.lock`, implement only the P0-selected artifact: universal image when P0 is green, otherwise the bounded release-set and manifest assembly. **RED:** show an unpinned base or runtime source/`tsx`/`next dev` layout fails. **GREEN:** pin bases, run as UID/GID 10001, exclude toolchain/tests/secrets/sources, and start each supported command from generated output. **TRIANGULATE:** prove API/manager/worker native loading and Next standalone separately. **REFACTOR:** deduplicate build/entrypoint logic; run `bun run test:contracts`, `bun run test:integration`, `bun run lint`, `bun run typecheck`, and `bun run build`. <!-- sdd-owner: implementation -->
- [ ] At `tests/e2e/release-image-readonly*` and the selected packaging/entrypoint surfaces, enforce the four-command read-only-root contract with ephemeral PostgreSQL, no provider egress, exact tmpfs paths, meaningful readiness/work, denied writes to `/opt/agendia`, `/etc`, and sibling paths, and restart independence from tmpfs. **RED:** fail on an undeclared mount or forbidden write. **GREEN:** add only required HOME/mount setup. **TRIANGULATE:** cover all four commands and each applicable selected artifact. **REFACTOR:** consolidate container harness setup; run `bun run test:contracts`, `bun run test:e2e`, `bun run lint`, `bun run typecheck`, and `bun run build`. <!-- sdd-owner: implementation -->
- [ ] At `packages/runtime-config/**`, `deploy/config/*.example.env`, four process entrypoints, and `tests/unit/runtime-config*`, add centralized per-process configuration and safe `_FILE` loading. **RED:** reject absent files, inline unsafe secrets, malformed digest/origin, and secret-bearing errors. **GREEN:** implement the minimum Zod loader requiring process/environment/release identity and process-specific DB URL files while rejecting generic release `DATABASE_URL`. **TRIANGULATE:** validate API, manager, worker, web, and one-shot variants with valid file-backed values. **REFACTOR:** share parsing/redaction; run `bun run test:unit`, `bun run test:contracts`, `bun run lint`, and `bun run typecheck`. <!-- sdd-owner: implementation -->
- [ ] At `packages/runtime-config/**`, DB marker migration/schema targets, and `tests/integration/*environment*`, reject crossed environment ID, DB host/name/login prefix, secret-set/hash, and staging E.164 identity manifests before readiness, listening, sessions, or worker activity. **RED:** cover crossed DB URLs, equal critical-secret hashes, and a production number in staging. **GREEN:** add fail-closed marker/preflight checks without revealing values. **TRIANGULATE:** exercise API, manager, and worker against valid isolated and invalid crossed markers. **REFACTOR:** centralize codes/reporting; run `bun run test:unit`, `bun run test:integration`, `bun run test:tenant-isolation`, `bun run lint`, and `bun run typecheck`. <!-- sdd-owner: implementation -->
- [ ] At existing health/logger/signal modules, `agendia_service_heartbeats` migration targets, and focused unit/integration tests, add web/API live-ready, loopback-only manager/worker probes, 30-second durable heartbeat, coded readiness reasons, redacted JSON logs, and controlled drain/lock release. **RED:** cover stale heartbeat, healthy idle worker, missing marker, SIGTERM drain, and a secret/JID/QR in log payload. **GREEN:** implement minimal probes, writer, handlers, and redactor. **TRIANGULATE:** prove every process and provider-independent liveness. **REFACTOR:** share probe/log contracts; run `bun run test:unit`, `bun run test:integration`, `bun run test:contracts`, `bun run lint`, and `bun run typecheck`. <!-- sdd-owner: implementation -->
- [ ] At `deploy/compose.yml`, bounded environment templates/cloudflared templates, teardown wrapper targets, and `tests/contracts/compose*`, define literal `agendia-prod`/`agendia-stg` networks, binds, labels, fixed digests, no host ports, hardening/tmpfs/resource/log/restart policies, staging capacity exclusions, and safe staging-only teardown. **RED:** reject tags, ports, shared paths, missing labels, and a teardown candidate containing `prod`. **GREEN:** implement minimum Compose/render/teardown behavior consuming the selected P0 representation. **TRIANGULATE:** render both environments and prove staging destruction preserves production IDs/checksums. **REFACTOR:** factor shared templates without weakening literal assertions; run `bun run test:contracts`, `bun run test:integration`, `bun run lint`, `bun run typecheck`, and `bun run build`. <!-- sdd-owner: implementation -->
- [ ] At role-provisioning SQL/scripts, `queue-init` command targets, and `tests/integration/*roles*`/`*queue-init*`, create scoped cluster-admin, migrator, API, manager, queue-publisher, worker, queue-owner, and backup roles with runtime DDL denied and pg-boss queues initialized exactly once. **RED:** prove runtime logins cannot DDL/cross capability boundaries and pg-boss cannot initialize implicitly. **GREEN:** implement idempotent separate-credential `provision-roles` and `queue-init`. **TRIANGULATE:** cover both environment naming schemes and manager publisher versus worker consumer grants. **REFACTOR:** consolidate auditable grant builders; run `bun run test:integration`, `bun run test:contracts`, `bun run db:check`, `bun run lint`, and `bun run typecheck`. <!-- sdd-owner: implementation -->
- [ ] At migration/ledger tables, the `migrate` one-shot target, compatibility manifest validation, and migration integration tests, implement finite advisory lock, marker and backup-evidence preflight, transactional checksums, existing-schema baseline, explicit compatibility modes, and no normal-startup migration. **RED:** reject changed historical SQL, lock contention, unledgered drift, missing backup evidence, and incompatible rollback. **GREEN:** implement the minimal algorithm and JSON evidence. **TRIANGULATE:** distinguish clean versus existing-schema baseline and both compatibility modes. **REFACTOR:** isolate inspection/ledger functions; run `bun run test:integration`, `bun run test:contracts`, `bun run db:check`, `bun run lint`, `bun run typecheck`, and `bun run build`. <!-- sdd-owner: implementation -->
- [ ] At `.github/workflows/ci.yml`, `release.yml`, release verification helpers, centralized PostgreSQL image lock target, and workflow fixtures, run configured suites, exact-SHA merged-PR checks, selected amd64 build/read-only contract, scan policy, GHCR publication, SPDX SBOM, provenance, and immutable release evidence. **RED:** reject missing lint, tag-only identity, failed check, unmerged/no-PR SHA, unpinned PostgreSQL, and unapproved HIGH exception. **GREEN:** implement least-privilege workflow/verifier. **TRIANGULATE:** test both P0 artifact modes and PR/main triggers without secrets. **REFACTOR:** deduplicate validation steps; run `bun run test:contracts`, `bun run lint`, `bun run typecheck`, and `bun run build`. <!-- sdd-owner: implementation -->
- [ ] At `.github/CODEOWNERS`, `authorize-promotion.yml`, governance matrix/runbook source, and authorization contract tests, implement manual same-digest staging then production authorization with truthful GitHub-plan fallback; keep MULTI-MAINTAINER controls documented but inactive. **RED:** reject missing staging evidence, digest mismatch, absent check, and claims of unavailable controls. **GREEN:** add minimum SOLO authorization manifest/checks without fictitious reviewers. **TRIANGULATE:** cover Environment available/unavailable paths and reject MULTI-only enforcement in SOLO mode. **REFACTOR:** centralize evidence schema; run `bun run test:contracts`, `bun run lint`, and `bun run typecheck`. <!-- sdd-owner: implementation -->
- [ ] At `scripts/deployctl.ts` and deployctl contract tests, accept only authorized digest identities; validate manifest/provenance/SBOM/platform/Compose, pull bound digests, atomically switch current/previous release files, enforce capacity/migration/restore/backlog gates, and forbid production destroy, checkout copy, or GitHub-to-host contact. **RED:** reject mutable tags, wrong platform, mixed sets, absent authorization, failed gates, and production destroy. **GREEN:** implement minimal parser/preflight/switch/rollback. **TRIANGULATE:** cover universal and release-set resolution and same-digest staging-to-production promotion. **REFACTOR:** isolate filesystem/Compose adapters; run `bun run test:unit`, `bun run test:contracts`, `bun run lint`, `bun run typecheck`, and `bun run build`. <!-- sdd-owner: implementation -->
- [ ] At `scripts/backup-production.ts`, backup evidence schema, `deploy/systemd/*`, secure config examples, and unit/integration tests, implement provider-agnostic restic/age backup orchestration using only an ephemeral local test repository. **RED:** reject local/same-PC destination, missing age recipient, stale/failed snapshot, and secret-leaking evidence. **GREEN:** create consistent dump, encrypted key bundle, release/schema evidence, retention/check scheduling, cleanup, and fail-closed gates. **TRIANGULATE:** parse SFTP/S3-style configuration without credentials and cover historical key versions. **REFACTOR:** share secure command/evidence helpers; run `bun run test:unit`, `bun run test:integration`, `bun run test:contracts`, `bun run lint`, and `bun run typecheck`. This does not configure a real destination or credentials. <!-- sdd-owner: implementation -->
- [ ] At `scripts/restore-drill.ts`, backup evidence schema, and Testcontainers restore contracts, restore only to an `agendia-restore-*` isolated project/volume; verify fingerprint/RLS/jobs, historical KEK/QR availability without plaintext logs, RPO/RTO JSON, and labeled teardown. **RED:** reject missing historical key, staging/production mount reuse, malformed evidence, and failed `pg_restore`. **GREEN:** implement the minimum isolated drill/evidence generator. **TRIANGULATE:** cover multiple key versions, snapshot dates, and compatibility modes. **REFACTOR:** share labels/evidence validation with backup/deployctl; run `bun run test:integration`, `bun run test:contracts`, `bun run db:check`, `bun run lint`, and `bun run typecheck`. This does not execute an external restore drill. <!-- sdd-owner: implementation -->
- [ ] At `docs/runbooks/{host-provisioning,deploy,staging-window,backup-restore,rollback,disaster-recovery,host-health}.md` and documentation contract tests, distinguish repository artifacts, host provisioning, promotion, application rollback, data recovery, full reconstruction, staging capacity, and deferred external gates using precheck → proposed command → verification → rollback guidance. **RED:** reject missing sections, unsafe port forwarding, or conflated application/data rollback. **GREEN:** add concise runbooks and explicit human approval points. **TRIANGULATE:** cover universal/release-set instructions and SOLO/MULTI distinctions. **REFACTOR:** normalize terminology/links; run `bun run test:contracts`, `bun run lint`, and `bun run typecheck`. <!-- sdd-owner: implementation -->
- [ ] At `tests/e2e/release-promotion*` and bounded verification helpers, simulate ephemeral Compose/Testcontainers staging and same-digest production promotion: selected identity, isolated config/secrets/roles/volumes, migrate then queue-init, four readiness/heartbeat checks, private smoke, evidence, safe teardown, and rollback compatibility. **RED:** fail a cross-environment resource or changed-digest promotion. **GREEN:** add only missing orchestration. **TRIANGULATE:** exercise selected behavior plus fallback fixture resolution and preservation of production IDs. **REFACTOR:** remove duplicate harness setup; run `bun run lint`, `bun run typecheck`, `bun run test:unit`, `bun run test:integration`, `bun run test:contracts`, `bun run test:tenant-isolation`, `bun run test:e2e`, `bun run test`, `bun run db:check`, and `bun run build`. No real host, Cloudflare, DNS, secrets, WhatsApp number, or external backup destination is used. <!-- sdd-owner: implementation -->
- [ ] Confirm authorized humans have supplied external-gate evidence before real-user enablement; repository tests, placeholders, and runbooks are not completion. <!-- sdd-owner: parent -->

## PR 1 lint prerequisite update

- Status consumed: OpenSpec `ready`; repo-local root and allowed edit root `/home/valerubio7/Projects/agendia`; attempt work unit `pr1-lint-prerequisite` only.
- Workload boundary: explicit `size:exception`/`exception-ok`; PR 1 stayed isolated and no PR 2 or parent-owned lifecycle action started.
- Completed: the PR 1 implementation row is visibly checked in persisted `tasks.md`.
- Files: `package.json`, `bun.lock`, `biome.json`, `tests/contracts/lint.contract.test.ts`, `tasks.md`, and this cumulative progress file.

### TDD Cycle Evidence

| Task | Test file | Layer | Safety net | RED | GREEN | TRIANGULATE | REFACTOR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PR 1 | `tests/contracts/lint.contract.test.ts` | Contract | `test:unit` 53/53; typecheck pass | 0/1: `Script not found "lint"`; violation was not diagnosed | 1/1: pinned Biome rejected TypeScript `noDoubleEquals` | 2/2: TypeScript and JSON duplicate-key violations were both diagnosed | Table-driven fixture cases plus centralized rules/includes/ignores; final 1/1 pass |

### Verification

- `bun install --frozen-lockfile` → pass in the checkout (390 installs/479 packages, no changes) and from a clean `HEAD` archive (373 packages installed).
- `bun test tests/contracts/lint.contract.test.ts` → pass, 1 test/6 assertions covering two distinct violation surfaces.
- `bun run lint` → pass, 150 files checked; `bun run typecheck` → pass; `bun run test:unit` → 53 pass/0 fail.
- Deviation/risk: Bun required `$HOME/.bun/bin` on PATH; the five pre-existing dirty files were excluded and a clean `HEAD` archive passed all PR 1 gates.
- This historical PR 1 update preceded PR 2. Parent lifecycle remains deferred.

## PR 2 immutable release manifest update

- Status consumed: `openspec`, `ready`, repo-local `/home/valerubio7/Projects/agendia`, allowed root matched; no action-context warnings. Delivery boundary: `pr2-immutable-release-manifest`, explicit `exception-ok`/`size:exception`.
- Completed: `packages/release-manifest/src/index.ts` validates strict discriminated `universal-image` and `release-set` manifests, immutable image/digest references, commit, `linux/amd64`, database compatibility, canonical serialization, and attestation/Compose bindings. The PR 2 implementation checkbox is visibly checked in `tasks.md`.
- Files changed: `packages/release-manifest/src/index.ts`, `tests/contracts/release-manifest.contract.test.ts`, `openspec/changes/establish-delivery-environments/{tasks.md,apply-progress.md}`.
- Design deviation: none. Both artifact kinds are validated independently of P0's universal-image result; the release-set identity remains its own manifest digest.

### TDD Cycle Evidence

| Task | Test file | Layer | Safety net | RED | GREEN | TRIANGULATE | REFACTOR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PR 2 | `tests/contracts/release-manifest.contract.test.ts` | Contract/pure validator | New implementation; focused final 3/3 | 0/1 with missing module | 3/3 after the minimal Zod validator and canonical serializer | Both artifact kinds pass; mismatched attestation and Compose images fail | Shared Zod digest schema; formatted and focused 3/3 green |

### Verification

- `bun test tests/contracts/release-manifest.contract.test.ts` → RED 0 pass/1 error (missing module); GREEN/REFACTOR 3 pass/0 fail, 11 assertions.
- `bun run test:contracts` → 41 pass/0 fail; `bun run lint` → 152 files checked; `bun run typecheck` → pass; `bun run build` → pass (7 static routes).
- Workload/PR boundary: PR 2 only; no downstream or parent-owned task changed. CodeGraph CLI exploration was used after the indexed MCP endpoint was unavailable.
- Remaining tasks: PR 3 and later implementation rows, plus the unchanged parent-owned external-gate confirmation, remain unchecked in `tasks.md`.

## PR 3 — P0-selected release packaging

- Completed the universal linux/amd64 image selected by P0 with immutable Bun bases, generated-only runtime output, UID/GID `10001`, a bounded dispatcher, and pinned image evidence.
- Strict TDD: focused packaging contract RED 0/3 before the Dockerfile existed, then GREEN 3/3 with 16 assertions; Docker build, contracts 46/46, integration 36/36, lint, typecheck, and build passed.
- Commit boundary: `.dockerignore`, `Dockerfile`, `deploy/entrypoint`, `deploy/images.lock`, `tests/contracts/release-image.contract.test.ts`. PR 4 and PR 5 remain outside this snapshot.
