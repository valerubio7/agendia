# Check host health

Use repository-provided health outputs as evidence; this runbook does not provision monitoring or alter host state.

## Precheck

- Check before a staging window, migration, restore, backup, or planned restart.
- Gather root and `/srv/agendia` space/inodes, RAM, swap, load, I/O wait, temperature, SMART, Docker restarts/OOMs, heartbeat age, backlog age, and latest valid backup.
- **Human approval required:** acknowledge a failed health gate before any override or maintenance action.

## Proposed command

```sh
sudo docker compose --project-name agendia-prod ps --format json
sudo docker stats --no-stream --format json
```

No repository artifact named `agendia-host-health` exists; collect the listed host metrics through approved local tooling and retain the output as evidence. Do not expose health endpoints with host ports or inbound port forwarding.

## Verification

Require production to remain within its approved baseline; defer staging when capacity, backup freshness, heartbeat, backlog, SMART, or thermal checks fail. Keep output free of secrets and tenant data.

## Rollback

Cancel the pending operation, keep production prioritized, and investigate from local logs/evidence. Do not restart or remove services solely to make a health check appear green.
