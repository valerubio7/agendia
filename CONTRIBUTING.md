# Contributing

Keep `main` stable. Work on short-lived `feat/`, `fix/`, `chore/` or `docs/`
branches and open one coherent pull request targeting `main`, with the relevant
code, tests and documentation together. Explain the outcome and how you checked it.

## Fast validation

Use the Bun version declared in `package.json` (1.4.0). Install dependencies with
`bun install --frozen-lockfile`, then run the same six checks as CI:

```sh
bun run typecheck
bun run test:scaffolding
bun run test:unit
bun run test:contracts
bun run scope:check
bun run security:scan
```

CI runs these checks for pull requests targeting `main` and pushes to `main`.
Integration, historical harness and system E2E tests remain outside this fast
gate: they require PostgreSQL, Docker and/or browsers. Run the relevant suites
separately when a change affects those behaviors; the aggregate `bun run test`
is not the fast gate.

## Merge and cleanup

After review and successful checks, squash-merge the PR and delete its remote
branch. Automatic remote branch deletion is enabled. Configure main protection
and required checks only after real successful hosted runs establish their names.
Review repository settings before assuming protection is active.

Use `git fetch --prune` to remove stale remote-tracking references; it does not
delete local branches. Review local branches individually before deleting them.
Do not automate deletion of unmerged work: squash merges may not appear merged
to Git's ancestry check, so verify the PR and preserve any remaining work rather
than forcing deletion.
