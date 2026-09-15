# Roll back an application release

## Application rollback

Return to a known immutable application digest only when its declared compatibility allows it. This does not restore PostgreSQL data or schema.

## Precheck

- Confirm current and previous release snapshots, matching environment, `expand-compatible` declaration, and prior digest.
- Pause ingress and record current readiness, heartbeat, release, and database evidence.
- **Human approval required:** approve the incident rollback and its compatibility decision.

## Proposed command

```sh
# Repository provenance check; this is not a host rollback command.
test -f scripts/deployctl.ts
```

`scripts/deployctl.ts` runs only from the separately prepared, root-owned clean checkout with the fixed Bun path described in `deploy.md`; it is not a host package or installed executable. Use the same digest-bound authorization context selected for the compatible snapshot. Never rebuild, choose a tag, mix a release-set image, or copy a development checkout to the host.

## Verification

Confirm the previous same digest and Compose hash are active, then repeat readiness and private smoke checks. Record the incident and preserve the failed-release evidence.

## Rollback

If rollback convergence fails, restore the recorded current Compose snapshot and escalate. For PostgreSQL loss or incompatible migration, use [backup and restore](backup-restore.md) and [data recovery](disaster-recovery.md), not this procedure.
