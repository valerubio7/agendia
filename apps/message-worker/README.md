# Message worker and agent code map

Start in `src/agent/` to change the agent harness. Queue processing lives in `src/jobs/`; shared instructions remain in the domain package because the API also displays them.

## Where to change what

| Change | File |
| --- | --- |
| Model/tool execution loop, round limits, timeout and cancellation | [`src/agent/runtime.ts`](src/agent/runtime.ts) |
| History, summaries and current-input assembly | [`src/agent/context.ts`](src/agent/context.ts) |
| Shared request-size budgeting | [`src/agent/limits.ts`](src/agent/limits.ts) |
| Tool definitions, argument validation and session lifecycle | [`src/agent/tools.ts`](src/agent/tools.ts) |
| Final-response validation and rendering | [`src/agent/response.ts`](src/agent/response.ts) |
| Tool execution against agenda data, ownership and transaction guards | [`src/agent/adapters/agenda.ts`](src/agent/adapters/agenda.ts) |
| AI jobs and conversation-summary processing | [`src/jobs/ai-job.ts`](src/jobs/ai-job.ts) |
| Queue subscriptions and worker startup | [`src/index.ts`](src/index.ts) |
| Canonical agent instructions shared with the API | [`packages/domain/src/agent/instructions.ts`](../../packages/domain/src/agent/instructions.ts) |
| DeepSeek HTTP integration | [`packages/ai-deepseek/src/deepseek-adapter.ts`](../../packages/ai-deepseek/src/deepseek-adapter.ts) |

## Boundaries

- The runtime coordinates model calls and tools; it does not receive a database repository.
- The agenda adapter keeps transactional execution, ownership checks and operation evidence together. Business rules remain in `packages/domain` and persistence in `packages/db`.
- Instructions are shared through the existing `@agendia/domain` export, not imported from the worker by the API.
- Existing exported symbols retain their names for compatibility. This reorganization changes file locations, not prompts, tool schemas or execution behavior.

## Checks

From the repository root:

```sh
bun run typecheck
bun run test:unit
```

Agent unit tests are in `tests/unit/receptionist-*.unit.test.ts`; database-backed scenarios are in `tests/integration/receptionist-*.integration.test.ts` and `tests/integration/whatsapp-agenda.integration.test.ts`.
