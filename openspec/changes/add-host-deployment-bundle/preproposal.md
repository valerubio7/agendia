# Pre-proposal handoff: add-host-deployment-bundle

## Confirmed product intent

- Deliver the smallest operational first SOLO-PILOT deployment path for the prepared Ubuntu 26.04 x86_64 server using repository-owned operator tooling from a clean checkout pinned to the exact release commit.
- Application containers continue to run immutable image digests; source execution is for operator tooling, not application hosting or image builds on the host.
- Reuse release evidence, staging→same-digest production promotion authorization, Compose isolation, deployctl atomic state/activation and compatible rollback, migration, queue-init, health and smoke contracts.
- Keep deployment pull-based and operator-controlled over authenticated LAN SSH.
- Do not redesign environments or implement Cloudflare/backup providers.
- Do not enable real users until external tunnel, backup/restore, secrets and accepted domestic-host risks are evidenced.

## Confirmed host facts

- Docker CE and Compose are installed from the official Ubuntu Resolute repository.
- SSH is key-only and UFW allows SSH only from the LAN; the central PC has already verified the host key.
- Production and staging have isolated `/etc/agendia` and `/srv/agendia` paths.
- `/srv` is a dedicated 200 GiB ext4 LV.
- The operator is `valerubio7` with sudo; no user belongs to the docker group.
- Wi-Fi-only and no-UPS operation is explicitly accepted, without waiving backup/restore requirements.
- Pinned Bun and the exact clean host checkout are requirements for later operational preparation, not installations performed or confirmed by this proposal.

## Research selection

Research is unselected. Existing repository evidence and the final human direction are sufficient for proposal revision.

## Confirmed final decisions

1. The central PC uses a clean repository checkout pinned to the exact release commit and manually verifies the exact GitHub CI/image artifacts and attestations with a pinned version of `gh`. Record repository/workflow/run, commit, immutable image digest, authorization and applicable SBOM/provenance evidence; local `verified: true` flags do not replace actual verification.
2. The central PC transfers only required configuration/evidence or operates over authenticated SSH with the already verified host key. No persistent GitHub token is stored on the host. No bundle transfer, approved tar checksum or SSH bundle installation is required for first deploy.
3. The prepared host will install/use pinned Bun and execute repository-owned operator tooling from the same exact clean release commit. Document checkout preparation and preserve the repository lockfile for necessary dependencies; do not introduce a source-packaging installer. Concrete compatible versions/commands belong in design/runbook, not invented host facts.
4. This is a trusted operator/pinned-source SOLO-PILOT path, not an independently verified host package. Manual CI/image attestation verification does not attest the host checkout as a separate package.
5. `valerubio7` remains the sudo operator; no application service or operator account joins the docker group. Keep secrets outside the checkout and evidence, and GHCR read-only credentials separate.
6. The first-admin secret uses a root-only one-shot tmpfs path under `/run`, is consumed once and unlinked after success. Preserve ordered PostgreSQL→roles→migration→queue-init→applicable admin bootstrap→apps, minimum mounts and refusal to replace an existing administrator.
7. Preserve staging validation before production promotion of the same immutable digest, environment/tenant isolation, atomic release state/activation, compatible image/Compose rollback and external gates. No SQL rollback is introduced.

## Superseded verifier/installer decisions

The final human direction abandons all separate bundle verifier/installer work for the first SOLO-PILOT deployment. It supersedes both the custom Ed25519/signed-receipt/Python/custom tar-parser approach and the later SSH/SCP bundle + approved SHA-256 + standard-tool installer approach. Neither is selected or a prerequisite. Do not replace them with another custom trust or packaging subsystem.

The trust boundary is the trusted central PC/operator, manual verification with pinned `gh`, exact clean source commit, pinned Bun and authenticated SSH operation. Do not claim independent host-package verification. Removing package installation does not remove atomic application release activation or rollback guarantees.

## Delivery continuity

- Retain completed Slice 1 deterministic bundle/CI provenance work as an optional future artifact, as confirmed by the user; it is not required for first deploy. This proposal does not re-verify that implementation or delete it.
- Retain the existing five-slice `feature-branch-chain` identifiers for traceability, but retire Slice 2 separate verifier/installer work and remove it from first-deploy dependencies.
- Continue the selected runtime/CLI/state/rollback, configuration/one-shots and bootstrap/integral-runbook scope of prior Slices 3–5 using direct pinned-source tooling.
- Preserve 400 changed lines per active slice, including tests/docs, with no size exception. Keep the tracker draft/no-merge and existing predecessor branch relationships; downstream tasks must reconcile functional dependencies without rewriting branches in this phase.
- If redistribution threatens the budget, pause under `ask-on-risk`; do not infer additional slices or publication consent.

## External gates and phase boundary

Real-user enablement remains blocked on tunnel/domain/DNS, external backup with proven restore, and separate secrets/identities evidence. Accepted Wi-Fi/no-UPS risks do not waive those gates. Backup executable/provider work remains out of scope; the timer referencing an absent executable must not be represented as operational.

This revision authorizes only proposal/preproposal changes. No code implementation, tool installation, deployment, host contact, commit, push or subagents. Product decisions are confirmed; no interview is needed. Downstream specs/design/tasks must be aligned separately before implementation.
