# Recover from a data or host loss

## Data recovery

Restore data only from verified encrypted external backup into an isolated project before any production replacement.

## Full host reconstruction

Rebuild host prerequisites, then restore selected data and release identity; this is distinct from application rollback.

## Precheck

- Declare the incident scope: application, data, or full host; stop if it is ambiguous.
- Confirm external snapshot, custodial keys, approved maintenance window, and production/staging isolation.
- **Human approval required:** authorize data replacement or host reconstruction.

## Proposed command

```sh
bun run backup:drill
# Repository provenance check; this is not a host deployment command.
test -f scripts/deployctl.ts
```

`bun run backup:drill` is repository-only verification and does not provide a production restore command. `scripts/deployctl.ts` is the repository artifact; production application deployment remains blocked until an authorized operator verifies a separately reviewed host package against its source and the approved `@sha256`. Validate recovery in isolation first; do not use local-only backup, staging volumes, mutable tags, rebuilds, or inbound port forwarding.

## Verification

Verify fingerprint, RLS, jobs, historical KEK/QR availability, environment marker, migration ledger, readiness, heartbeat, and recorded RPO/RTO before reopening ingress.

## Rollback

Keep the original production volume untouched until approval of the isolated result. If recovery fails, preserve evidence and return to the last safe state; do not treat an application digest rollback as data recovery.
