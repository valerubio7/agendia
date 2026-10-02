# Deploy a validated release

Whole CI success on a trusted main push plus passing CD regressions on that exact source gates publication of full-SHA runtime/web images to GHCR. **Deploy production** is manual, approved through the production environment, and updates the existing Compose installation with downtime. No real deployment has been verified yet. Bootstrap the server using [DEPLOYMENT.md](DEPLOYMENT.md) first.

## Setup checklist (before enabling deployment)

- [ ] Protect main and workflow changes; restrict Actions and GHCR write access to trusted maintainers. SHA tags are names, not immutable registry policy: do not overwrite them. Deployment resolves tags to digests and verifies revision labels; registry writers remain trusted.
- [ ] Create the `production` GitHub environment: required reviewers, prevent self-review, disable administrator bypass, restrict deployment branches to main. Confirm the repository plan/visibility supports and enforces these protections. **If approvals cannot be enforced, do not configure deployment secrets or run the workflow.** YAML alone does not enforce approval.
- [ ] Set environment variables: `PRODUCTION_SSH_HOST`, `PRODUCTION_SSH_USER`, `PRODUCTION_SSH_PORT`, `PRODUCTION_APP_DIR` (absolute path, no spaces/dots), `PRODUCTION_COMPOSE_PROJECT` (existing lowercase Compose project name).
- [ ] Set environment secrets `PRODUCTION_SSH_KEY` and `PRODUCTION_KNOWN_HOSTS`. Obtain host fingerprints through an independent trusted channel; include `[host]:port` for nonstandard ports. Never accept a fresh network scan as identity verification.
- [ ] Provision noninteractive SSH key access for the deployment user, Bash, Docker Compose v2, and `flock`. The user needs write access to the existing application directory and Docker. **Docker access is effectively root access**: this is not a restricted SSH command account. Use a dedicated trusted account/key.
- [ ] For private GHCR images, log Docker in once **as that same server user** using a read-packages credential via `--password-stdin`; secure its credential store. Tokens are never sent as deployment arguments. The publisher uses its short-lived job token only on the runner.
- [ ] Keep the existing `deploy/.env.production`, current Compose file and all encryption keys on the server; maintain encrypted off-host backups of those files plus PostgreSQL. Preserve the existing project identity and `postgres-data` volume. Verify it with the existing installation before configuring variables: a different project would select different volumes.
- [ ] Ensure all required Compose variables (including bootstrap-admin variables referenced during config validation) exist in the bootstrap's `deploy/.env.production`. All deployment Compose commands use that file directly; no root `.env`, secret copying or regeneration is required. The script is an **update**, requiring existing running api/web/worker/manager and database, not first-install/bootstrap automation.
- [ ] Ensure sufficient disk space for images, protected SQL backups, retained release files and Docker logs. Test restore procedures and schedule retention separately; deployment never prunes or deletes volumes.

## Execute

1. Merge trusted changes to main. Wait for the entire **CI** workflow, then **Publish release**, to succeed for the exact commit. Publishing runs `bun test tests/deployment.test.ts` in the downloaded release's `source` directory before Docker login/build/push, using the same pinned Bun setup/version as CI without dependency installation. No PR artifacts are consumed; native Docker builds use that commit's source archive without persisted Git credentials.
2. On main, dispatch **Deploy production** with the full lowercase 40-character commit SHA; approve its production environment deployment. It checks main ancestry and successful CI/publish runs for that SHA, then downloads the script and Compose from that release. The first deployable commit must contain these files. Verification checks the latest 100 publisher runs and fails closed for older releases; republish through a trusted CI rerun if needed. Publisher run titles bind the triggering release SHA, since workflow_run's own head SHA can be a newer default-branch tip.
3. Check the run result and application externally. The script pulls digest-pinned images and validates config before downtime, creates a mode-600 nonempty `pg_dump`, stops app services, migrates/provisions with new images, then starts without builds. Health waits up to 300 seconds plus command latency. Worker/manager checks prove running processes only, not semantic readiness.

Workflow executions are queued without cancellation. A nonblocking host-local lock in the existing application directory rejects overlapping SSH/manual deployments using the same installation path. Always use that same canonical path/project. Do not deploy unrelated releases concurrently outside this entrypoint.

## Failure and recovery

Before stopping, errors leave app services untouched. After stopping, migration/provision/start/health failures fail closed: no automatic restart of old images or schema rollback. New services may be partially running after a failed start/health check; inspect them and deliberately stop them if necessary. Never assume an unsuccessful migration made no schema changes.

`releases/<sha>.<unique>/` retains the selected Compose, digest `images.env`, actual pre-update image IDs in `previous-images`, and version-matched `previous-compose.yml`. `backups/` retains protected SQL dumps, including failed/empty attempts (only successful nonempty dumps permit downtime). `.release-state` atomically records current and previous successful release directories after health succeeds; failed attempts never replace it. No images/backups are deleted.

For manual **image recovery**, first establish schema compatibility. Use the failed attempt's `previous-compose.yml` and actual `previous-images` runtime/web refs, or the previous successful directory's Compose and `images.env`, with the same `--project-name` and `--env-file <app-dir>/deploy/.env.production`; explicitly export image refs and use `up -d --no-build`, not latest source or a local rebuild. Prior image IDs must still exist locally. Do not re-run old migrations blindly. Never use `down -v` or prune.

For **database recovery**, stop writers and follow a separately tested PostgreSQL restore procedure into the correct database/volume, using the pre-update dump and matching env/encryption keys. Restoring loses writes after the backup snapshot. Image rollback alone cannot undo migrations or role provisioning; take a human recovery decision.

## Next step

Local mocks verify sequencing and lock behavior, not SSH reachability, registry permissions, approval enforcement or production health. Complete setup, rehearse restore, then explicitly authorize and observe the first real deployment.
