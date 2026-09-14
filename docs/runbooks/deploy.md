# Promote an immutable release

Use repository-produced authorization, manifest, provenance, SBOM, and Compose artifacts. Host provisioning and external gates are separate.

## Precheck

- Confirm the selected release identity is `@sha256`, CI evidence is green, and staging evidence names the same digest.
- Confirm environment-specific config, secrets, roles, volumes, and production current/previous IDs remain isolated.
- On the central PC, use **gh 2.76.2** to bind the exact repository, run, commit, digest, authorization, SBOM, and provenance; record redacted identifiers only.
- **Human approval required:** authorize staging, then separately authorize production.

## Proposed command

```sh
sudo env -i PATH=/usr/bin:/bin sh -ceu 'r=/opt/agendia/tooling/<40-hex-commit>; cd "$r"; test "$PWD" = "$r"; test -s bun.lock; test "$(git rev-parse HEAD)" = "<40-hex-commit>"; test -z "$(git status --porcelain=v1 --untracked-files=all | grep -v "^!! node_modules/$")"; ! find "$r" -xdev \( ! -user root -o -perm /022 \) -print -quit | grep -q .'
```

Run that separate pre-import guard after root-owned `bun install --frozen-lockfile --ignore-scripts`; it checks checkout identity, lock presence, and recursive ownership, not ignored dependency-byte integrity.

```sh
sudo env -i PATH=/usr/bin:/bin /opt/agendia/tools/bun-1.4.0/bin/bun --no-env-file /opt/agendia/tooling/<40-hex-commit>/scripts/deployctl.ts status staging --commit <40-hex-commit> --digest sha256:<64-hex-digest>
```

Closed grammar: `plan|apply|bootstrap|status|smoke|rollback staging|production --commit <40-hex> --digest sha256:<64-hex>`; no paths, JSON, shell, build, push, checkout, tag, URL, project, image, or passthrough flags. `universal-image` uses the shared image digest; `release-set` uses the manifest digest.

## Verification

Record the selected digest, authorization, migration/queue-init evidence, readiness, heartbeat, private smoke result, and staged Compose hash. `SOLO PILOT` uses truthful manual workflow authorization; required reviewers and self-review prevention are not configured as active controls in SOLO PILOT. `MULTI-MAINTAINER` additionally requires the configured independent controls when available.

## Rollback

Use [application rollback](rollback.md) only when compatibility permits. It changes the application release and does not restore PostgreSQL data or schema.

## Deferred external gates

Do not enable real users until authorized humans verify tunnel/domain/DNS, external backup and restore, and Wi-Fi/no-UPS acceptance.
