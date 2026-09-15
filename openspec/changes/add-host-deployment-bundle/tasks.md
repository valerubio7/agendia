# Tasks: add-host-deployment-bundle

## Review Workload Forecast

| Field | Value |
| --- | --- |
| Estimated changed lines | 1,280–1,650 active delivery: 1,080–1,350 active code/tests/docs plus 200–300 OpenSpec tracker impact; optional completed Slice 1 is measured separately |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Draft tracker → PR 1 optional-complete → PR 2 withdrawn → PR 3 direct runtime → PR 4 config/genesis → PR 5 bootstrap/runbooks |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

This is the one honest split permitted by the final direct pinned-source design. Slice 1 stays complete but optional. Slice 2 is **withdrawn and not implementation-complete**; its rejected history remains in `apply-progress.md`. The only active units are Slices 3–5: direct CLI/runtime/state, configuration/roles/migrate/queue/genesis, and admin/bootstrap/lifecycle/runbooks.

Active forecasts are Slice 3 **350–410**, Slice 4 **380–500**, and Slice 5 **350–440** additions plus deletions. Thus no honest claim exists that all active final candidates fit 400 lines. Before apply, measure each candidate against its immediate parent; if any is above 400, stop under `ask-on-risk`. Do not create an exception, extra slice, bundle/checksum-transfer substitute, or another verifier/installer subsystem.

The draft/no-merge tracker contains OpenSpec delivery artifacts (`preproposal.md`, `proposal.md`, `design.md`, applicable specs, and this file) and is not a functional slice. This phase plans only: it performs no deletion, implementation, deployment, host contact, commit, push, branch, PR, or subagent action.

## Chain topology

```text
main ← tracker (draft/no-merge) ← PR 1 ← PR 2 (withdrawn) ← PR 3 ← PR 4 ← PR 5
```

## Slice 1 / PR 1 — complete optional deterministic bundle artifact

**Status:** complete according to the user; optional and non-authoritative for the direct pinned-source path.
**Budget:** recover and measure historic diff only; it is not part of active first-deploy scope.
**Boundary:** preserve its packaging/CI/stub/tests without reimplementation or use as a deployment prerequisite.

**Allowed edit surfaces:** none for new Slice 1 work. Preserve only `.github/workflows/release.yml`, `scripts/package-host-bundle.ts`, `scripts/deployctl-cli.ts`, and `tests/contracts/host-bundle.contract.test.ts` where the exact completed candidate is retained.

- [x] **RED:** Preserve the completed deterministic-bundle coverage without relying on it for the direct source path. <!-- sdd-owner: implementation -->
- [x] **GREEN:** Preserve the completed optional artifact and closed bundle CLI stub without extending either. <!-- sdd-owner: implementation -->
- [x] **TRIANGULATE:** Preserve the completed artifact-integrity regressions without making them an active deployment gate. <!-- sdd-owner: implementation -->
- [x] **REFACTOR:** Preserve the completed Slice 1 boundaries without refactoring them for direct tooling. <!-- sdd-owner: implementation -->

## Slice 2 / PR 2 — withdrawn installer attempt

**Status:** withdrawn; **not implementation-complete** and not an active dependency.
**History:** keep the rejected attempt and its failure in `openspec/changes/add-host-deployment-bundle/apply-progress.md`; do not rewrite it as green or delete it during this planning phase.
**Boundary:** do not continue, repair, replace, import, execute, or count separate verifier/install/checksum-transfer work as part of first deploy. If rejected candidate files remain in a future base, their deletion or exclusion is explicit sanitation requiring measured review and a human decision; it is not hidden in an active child diff.

**Retired surfaces, outside active implementation scope:**

- `scripts/verify-host-handoff.ts`
- `scripts/install-host-bundle.py`
- `tests/contracts/host-handoff-install.contract.test.ts`
- `scripts/verify-host-release.ts`
- `scripts/install-host-bundle.sh`
- `tests/contracts/host-install.contract.test.ts`

No Slice 2 checkbox is marked complete because the installer path is withdrawn, not delivered.

## Slice 3 / PR 3 — direct pinned-source CLI, runtime, state, and compatible rollback

**Forecast:** 350–410 changed lines; **risk:** High. The upper bound exceeds 400, so this child is blocked until an exact ≤400 candidate exists.
**Start/prior dependency:** direct pinned-source preflight only; targets the existing PR 2 parent without requiring an installer.
**Finish/rollback boundary:** the root-owned clean checkout and fixed Bun execute a closed CLI; unsafe or incomplete operations retain confirmed state and redacted evidence, while compatible rollback remains image/Compose-only.
**Follow-up/out of scope:** per-process configuration, one-shots, genesis, and admin bootstrap are Slices 4–5; no Git mutation, source application execution, build, or host package activation is added.

**Child dependency diagram:**

```text
main ← tracker ← PR 1 ← PR 2 (withdrawn) ← 📍 PR 3
```

**Allowed edit surfaces (and no others):**

- `scripts/deployctl.ts`
- `scripts/host-deployment-runtime.ts` (new)
- `tests/contracts/deployctl.contract.test.ts`
- `tests/contracts/host-runner.contract.test.ts` (new)
- `docs/runbooks/deploy.md` (only direct source/Bun preflight and closed invocation)

- [x] **RED:** Add failing contracts for exact clean root-owned source preflight (commit, no branch/dirty tree, pinned Bun, frozen root-owned dependencies, no dotenv/preload drift), closed `deployctl.ts` grammar for `plan|apply|bootstrap|status|smoke|rollback`, mandatory environment/commit/digest, and exact Docker/Compose argv. Reject alternate checkout, Git mutation, JSON passthrough, shell, build/push/checkout, mutable tags, arbitrary paths/URLs/projects/images, Docker-socket application access, and poisoned environment. <!-- sdd-owner: implementation -->
- [x] **GREEN:** Add guarded `parseHostCommand`/`main` to `scripts/deployctl.ts` and implement the injected direct runtime preflight, typed operations, fixed `/usr/bin/docker` (read-only), `shell:false`, bounded timeout/output, minimal environment, fixed root-only Docker config, digest/amd64 inspection, and existing-plan/seal integration. Persist state schema 1, rendered Compose, and closed phase evidence atomically only after convergence/checks. <!-- sdd-owner: implementation -->
- [x] **TRIANGULATE:** Add fault injection for dirty/mismatched source and runtime, lock contention, partial state/Compose/evidence writes, redaction of errors/env/URLs/stdout, failed effects, and compatible/incompatible rollback. Prove rollback runs no roles/migrate/queue/admin, never claims SQL rollback or external restore, and never auto-reconverges after unsafe effects. <!-- sdd-owner: implementation -->
- [x] **REFACTOR:** Consolidate only source-preflight, typed-runner, and persistence fixtures without expanding CLI input or source-trust scope; measure additions plus deletions and stop under `ask-on-risk` above 400. <!-- sdd-owner: implementation -->

**Verification commands:**

```sh
bun test tests/contracts/deployctl.contract.test.ts tests/contracts/host-runner.contract.test.ts
bun run lint
bun run typecheck
bun run test:contracts
```

## Slice 4 / PR 4 — isolated configuration, roles, migrate, queue, and governed genesis

**Forecast:** 380–500 changed lines; **risk:** High. The maintainer explicitly authorized a Slice-4-only ceiling of 800 changed lines; stop if the exact candidate exceeds it.
**Start/prior dependency:** requires Slice 3’s direct typed runtime; targets the PR 3 branch using temporary roots and fake Docker/Compose.
**Finish/rollback boundary:** absent/crossed configuration fails before PostgreSQL; a non-bootstrap operation runs PostgreSQL → roles → migrate → queue-init → apps/checks, while bootstrap-required operation stops before apps. Any predecessor failure prevents convergence.
**Follow-up/out of scope:** privileged bootstrap secret lifecycle and final integration/runbooks are Slice 5; historical SQL migrations remain unchanged.

**Child dependency diagram:**

```text
main ← tracker ← PR 1 ← PR 2 (withdrawn) ← PR 3 ← 📍 PR 4
```

**Allowed edit surfaces (and no others):**

- `deploy/compose.yml`
- `deploy/config/release.example.env`
- `deploy/entrypoint`
- `Dockerfile`
- `scripts/render-compose.ts`
- `scripts/release-entrypoint-config.ts`
- `scripts/provision-roles.ts`
- `scripts/queue-init.ts`
- `scripts/migrate.ts`
- `scripts/support/database-role-provisioning.ts`
- `scripts/support/postgres-migrations.ts`
- `scripts/host-deployment-runtime.ts`
- `packages/runtime-config/src/index.ts`
- `tests/contracts/host-config-genesis.contract.test.ts` (new)
- `tests/contracts/compose-isolation.contract.test.ts`
- `tests/unit/runtime-config.unit.test.ts`
- `tests/integration/governed-migrations.integration.test.ts`

- [x] **RED:** Add failing contracts for literal required per-process `env_file`, fixed process/environment/release identity, individual secret mounts, no normal-process `DATABASE_URL`, and absent/crossed config, secret, database, network, or identity without leaked values. Add fake-runtime ordering/failure cases for PostgreSQL → roles → migrate → queue-init → apps/checks and bootstrap-required blocking before apps. <!-- sdd-owner: implementation -->
- [x] **GREEN:** Render/preflight the isolated configuration; add opt-in minimum-network/mount roles/migrate/queue services with no persistent one-shot logging; wire Dockerfile/entrypoint/runtime configuration; and execute the non-bootstrap order through Slice 3’s runner. Implement governed genesis under the migration advisory lock with static identity validation, catalog/ledger constraints, pgboss creation before ownership changes, and protected marker insertion. <!-- sdd-owner: implementation -->
- [x] **TRIANGULATE:** Cover empty genesis, identity/marker mismatch, partial-ledger retry for the same valid digest, unmarked pre-existing database rejection, pgboss absence, no backup-gate bypass, and no app start after predecessor failure or unfinished bootstrap. Use doubles locally; reserve real PostgreSQL coverage for authorized CI. <!-- sdd-owner: implementation -->
- [x] **REFACTOR:** Narrow only static-versus-marker validation and internal migration hooks while retaining advisory-lock safety; do not edit historical migrations, measure the full diff, and stop under `ask-on-risk` above the authorized 800-line ceiling. <!-- sdd-owner: implementation -->

**Verification commands:**

```sh
bun test tests/contracts/host-config-genesis.contract.test.ts tests/contracts/compose-isolation.contract.test.ts tests/unit/runtime-config.unit.test.ts
bun run lint
bun run typecheck
bun run test:contracts
# CI-authorized database coverage only:
bun test tests/integration/governed-migrations.integration.test.ts
```

## Slice 5 / PR 5 — ephemeral admin bootstrap, direct lifecycle contract, and truthful runbooks

**Budget:** the maintainer explicitly authorized a Slice-5-only ceiling of 1,200 changed lines; stop if the exact candidate exceeds it.
**Start/prior dependency:** requires Slice 4’s non-bootstrap sequence; targets the PR 4 branch using temporary roots and fake Docker/Compose.
**Finish/rollback boundary:** explicit bootstrap consumes the root-only tmpfs secret and unlinks it only after structured `created|existing`; cleanup failure blocks convergence. The lifecycle contract documents direct pinned-source operation without asserting host or real-user readiness.
**Follow-up/out of scope:** no host package, installer, verifier, checksum transfer, backup provider/timer enablement, deployment, SQL rollback, or real-user admission.

**Child dependency diagram:**

```text
main ← tracker ← PR 1 ← PR 2 (withdrawn) ← PR 3 ← PR 4 ← 📍 PR 5
```

**Allowed edit surfaces (and no others):**

- `scripts/bootstrap-admin.ts`
- `scripts/host-deployment-runtime.ts`
- `deploy/compose.yml`
- `deploy/entrypoint`
- `Dockerfile`
- `scripts/bootstrap-admin.test.ts`
- `tests/contracts/host-bootstrap.contract.test.ts` (new)
- `tests/contracts/host-deployment.integration.contract.test.ts` (new)
- `tests/contracts/runbooks.contract.test.ts`
- `docs/runbooks/deploy.md`
- `docs/runbooks/rollback.md`
- `docs/runbooks/host-provisioning.md`
- `docs/runbooks/backup-restore.md`
- `deploy/systemd/agendia-backup.service` (only to preserve disabled/no-binary truth)
- `deploy/systemd/agendia-backup.timer` (only to preserve disabled/no-binary truth)

- [x] **RED:** Add failing bootstrap contracts for explicit request, tmpfs/mountinfo, fixed `/run` (read-only) path, no-follow root-only mode/owner/link-count/inode checks, same versus different existing administrator, transaction failure, post-commit retry, unlink failure, and secret sentinel absence from argv/environment/checkout/logs/state/evidence/manifests. Add direct-lifecycle/runbook assertions for pinned source preflight → staging → same-digest authorized production → update/failure → compatible rollback and all external gates. <!-- sdd-owner: implementation -->
- [x] **GREEN:** Implement minimal root-only bootstrap mount, read-only rootfs, dropped capabilities, no-new-privileges, data-only network, structured result parsing, inode-aware unlink after `created|existing`, and failure-closed convergence. Add only temporary-root/fake-runtime lifecycle orchestration and direct-source runbook steps for clean checkout, pinned Bun/gh, manual evidence, SSH, configuration, smoke, compatible rollback, evidence limits, disabled backup, and blocked real-user gates. <!-- sdd-owner: implementation -->
- [x] **TRIANGULATE:** Prove environment separation, wrong commit/digest/authorization context rejection, no-app-start after bootstrap failure, redacted evidence, incompatible rollback, no SQL rollback/restore claim, and continued blocking without tunnel/domain/DNS, external backup/restore evidence, or separate identities. Assert Wi-Fi/no-UPS is not backup and no backup executable/link is installed. <!-- sdd-owner: implementation -->
- [x] **REFACTOR:** Deduplicate only bootstrap fake-runtime and runbook assertion helpers without reducing secret or external-gate coverage; measure the full diff and stop above the maintainer-authorized 1,200-line ceiling. <!-- sdd-owner: implementation -->

**Verification commands:**

```sh
bun test scripts/bootstrap-admin.test.ts tests/contracts/host-bootstrap.contract.test.ts tests/contracts/host-deployment.integration.contract.test.ts tests/contracts/runbooks.contract.test.ts
bun run lint
bun run typecheck
bun run test:contracts
```

## Parent-owned bounded review and lifecycle gates

- [ ] Before authorizing any active slice, verify that Slice 2 remains withdrawn and that no active candidate imports, executes, or documents retired verifier/install/checksum-transfer surfaces; preserve its rejected history in `apply-progress.md`. <!-- sdd-owner: parent -->
- [ ] Require each active child to stay within its explicitly authorized per-slice ceiling; pause under `ask-on-risk` before any new size exception. <!-- sdd-owner: parent -->
- [ ] Create or reuse the draft/no-merge tracker only after apply authorization, verify each active child targets its immediate predecessor, and reject polluted diffs instead of folding sanitation into functional work. <!-- sdd-owner: parent -->
- [ ] After each active child, start or reuse bounded review of its allowed surfaces, strict-TDD evidence, security coverage, measured diff, verification output, and rollback boundary before allowing the next child. <!-- sdd-owner: parent -->
- [ ] Keep host contact, deployment, backup enablement, and real-user admission outside all active repository slices until explicit operator authorization and external evidence are supplied. <!-- sdd-owner: parent -->
