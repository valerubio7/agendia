# Run a staging window

Staging is private, temporary, and isolated; production has priority.

## Precheck

- Require an approved window and current host-health evidence.
- Reject staging during migration, restore, maintenance, backlog, build, or test activity.
- Confirm distinct `agendia-stg` resources, test identity, secrets, roles, volumes, and no production IDs.
- **Human approval required:** approve capacity and the private-access window.

## Proposed command

```sh
# Repository provenance check; this is not a host deployment command.
test -f scripts/deployctl.ts
```

`scripts/deployctl.ts` is the real repository artifact, but no host `deployctl` executable is shipped here. Keep staging blocked until an authorized operator verifies a separately reviewed host package against that source and the selected immutable digest. Do not publish host ports or use inbound port forwarding.

## Verification

Check limits, production health, four release readiness/heartbeat checks, private smoke, evidence, and that production volume IDs/checksums are unchanged after teardown.

## Rollback

Pause ingress and tear down only labeled `agendia-stg` resources. Preserve staging evidence; never destroy or reuse production resources.
