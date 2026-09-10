# Host provisioning

Repository artifacts define the release path; this runbook proposes one-time host work and does not execute it from CI or deployctl.

## Precheck

- Confirm console access, a second LAN SSH session, Ubuntu x86_64, and a configuration backup.
- Record disk, SMART, RAM, swap, Wi-Fi, and Docker capacity before changing the host.
- **Human approval required:** approve the host baseline and local-risk acceptance.

## Proposed command

```sh
sudo install -d -m 0750 /etc/agendia/production /etc/agendia/staging /srv/agendia
sudo docker version
```

Install Docker only from the reviewed vendor repository for the detected Ubuntu release; abort if it is unsupported. The service account must not join the `docker` group.

## Verification

Confirm `/etc/agendia/{production,staging}` and `/srv/agendia/{production,staging}` are distinct, Docker is healthy, and no application service exposes host ports. inbound port forwarding is prohibited; ingress requires the separately approved outbound tunnel.

## Rollback

Stop before applying unreviewed package, network, disk, firewall, or account changes. Restore the recorded configuration backup; do not remove production data directories.

## Deferred external gates

External gates remain deferred: approved outbound tunnel/domain/DNS, external backup destination and tested restore, and written Wi-Fi/no-UPS risk acceptance are required before real-user enablement.
