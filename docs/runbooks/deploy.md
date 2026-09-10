# Promote an immutable release

Use repository-produced authorization, manifest, provenance, SBOM, and Compose artifacts. Host provisioning and external gates are separate.

## Precheck

- Confirm the selected release identity is `@sha256`, CI evidence is green, and staging evidence names the same digest.
- Confirm environment-specific config, secrets, roles, volumes, and production current/previous IDs remain isolated.
- **Human approval required:** authorize staging, then separately authorize production.

## Proposed command

```sh
# Repository provenance check; this repository does not ship a host deployctl executable.
test -f scripts/deployctl.ts
```

`scripts/deployctl.ts` is the repository orchestration artifact, not an installed CLI. An authorized host operator may apply only a separately reviewed, provenance-verifiable host package that maps to that artifact and the selected `@sha256` release; otherwise promotion remains blocked. For `universal-image`, the digest names the shared image. For `release-set`, it names the immutable release manifest; never substitute a linked image digest, tag, branch, checkout, or rebuild.

## Verification

Record the selected digest, authorization, migration/queue-init evidence, readiness, heartbeat, private smoke result, and staged Compose hash. `SOLO PILOT` uses truthful manual workflow authorization; required reviewers and self-review prevention are not configured as active controls in SOLO PILOT. `MULTI-MAINTAINER` additionally requires the configured independent controls when available.

## Rollback

Use [application rollback](rollback.md) only when compatibility permits. It changes the application release and does not restore PostgreSQL data or schema.

## Deferred external gates

Do not enable real users until authorized humans verify tunnel/domain/DNS, external backup and restore, and Wi-Fi/no-UPS acceptance.
