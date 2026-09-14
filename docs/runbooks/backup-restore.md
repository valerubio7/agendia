# Back up and restore data

This procedure covers the required future encrypted external backup and isolated restore verification, not application promotion; no backup executable is delivered.

## Precheck

- Confirm staging is stopped, load gates allow backup, and the destination is outside the host PC.
- Confirm the timer remains disabled because no backup executable or provider is delivered.
- Confirm the age recipient, restic credentials, historical KEK inventory, and QR key availability without printing values.
- **Human approval required:** approve destination, custodians, and each restore drill.

## Proposed command

```sh
systemctl is-enabled agendia-backup.timer # must report disabled
bun run backup:drill
```

`deploy/systemd/agendia-backup.service` remains a disabled truth marker, not an installed provider or broken link. `bun run backup:drill` runs the repository-only Testcontainers drill and does not replace production data or satisfy an external restore. Use only an isolated `agendia-restore-*` project/volume for any approved drill.

## Verification

Record snapshot ID, encrypted dump, release/schema evidence, historical key-version availability, fingerprint/RLS/jobs result, RPO/RTO, and labeled teardown evidence.

## Rollback

Stop the failed drill and remove only its labeled restore resources. Do not overwrite staging or production; follow [data recovery](disaster-recovery.md) for a real data incident.
