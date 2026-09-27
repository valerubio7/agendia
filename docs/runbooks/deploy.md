# Promote an immutable release

Use repository-produced authorization, manifest, provenance, SBOM, and Compose artifacts. Host provisioning and external gates are separate.

## Precheck

- Confirm the selected release identity is `@sha256`, CI evidence is green, and staging evidence names the same digest.
- Confirm environment-specific config, secrets, roles, volumes, and production current/previous IDs remain isolated.
- On the central PC, use **gh 2.76.2** to bind the exact repository, run, commit, digest, authorization, SBOM, and provenance; record redacted identifiers only.
- **Human approval required:** authorize staging, then separately authorize production.

## Proposed command

After root-owned `bun install --frozen-lockfile --ignore-scripts`, run the separate [pinned source pre-import guard](deploy-source-preflight.md) before importing `scripts/deployctl.ts`. Stop if the guard fails; it does not check ignored dependency byte integrity.

```sh
sudo env -i PATH=/usr/bin:/bin /opt/agendia/tools/bun-1.4.0/bin/bun --no-env-file /opt/agendia/tooling/<40-hex-commit>/scripts/deployctl.ts status staging --commit <40-hex-commit> --digest sha256:<64-hex-digest>
```

Closed grammar: `plan|apply|bootstrap|status|smoke|rollback staging|production --commit <40-hex> --digest sha256:<64-hex>`; no paths, JSON, shell, build, push, checkout, tag, URL, project, image, or passthrough flags. `universal-image` uses the shared image digest; `release-set` uses the manifest digest.

## Verification

Record the selected digest, authorization, migration/queue-init evidence, readiness, heartbeat, private smoke result, and staged Compose hash. `SOLO PILOT` uses truthful manual workflow authorization; required reviewers and self-review prevention are not configured as active controls in SOLO PILOT. `MULTI-MAINTAINER` additionally requires the configured independent controls when available.

## Rollback

Use [application rollback](rollback.md) only when compatibility permits. It changes the application release and does not restore PostgreSQL data or schema.

## Provisional first-install exception (not formal deployctl)

Only for identity-matched staging or production with the zero previous-release sentinel and no existing application relations in user schemas, migration-ledger table, or environment marker, governed migrations may proceed without backup evidence. This does **not** prove the database catalog is empty: unrelated functions, types, operators, and empty custom schemas may remain. This is **not a tested backup or a rollback promise**; existing application relations, marker, or ledger require the normal backup gate. Keep config, passwords, and tunnel credentials external to Git; never fabricate backup evidence.

With a matching pinned source checkout and newly CI-checked immutable image, bootstrap each environment's direct Compose stack in order: PostgreSQL, roles, governed migrations, queues, application, then tunnel connector. Verify staging behind Access with private smoke before seeking separate approval for public production. Independently configure production and repeat the ordered bootstrap and public HTTPS owner smoke. Public reachability for owner smoke is permitted under the accepted provisional risk; this does **not** declare real-user onboarding safe. This is an operator sequence, **not a claim that either host ran**. No application rollback can restore lost database state.

## Deferred external gates

Do not enable real users until authorized humans verify tunnel/domain/DNS, external backup and restore, and Wi-Fi/no-UPS acceptance.
