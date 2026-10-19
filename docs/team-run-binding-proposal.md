# Durable Team Run binding proposal

The current `teamTaskFence` is a transaction-only write fence. It authorizes a Run/Thread mutation while the Team executor owns the parent task, but it is not persisted in `RunState`; Runtime Worker therefore cannot select a Team-scoped tool runtime from a reopened Run.

## Binding shape

Add an internal, immutable Run binding with:

- `tenantId`
- `spaceId`
- `teamTaskId`
- `parentTaskId` (the task that admitted the Run)
- `admissionEpoch`
- `capabilitySnapshotId`

The binding is server-created from the current Team fence and trusted host capability. It is never accepted from HTTP, browser input, model output or a generic tool invocation.

## Write boundary

The binding must be written in the same transaction that creates the Run and its queue work item. The Team fence must be checked against the coordinating journal row before the commit. A lost response replays the original binding; a same-key request with a different binding fails closed.

## Runtime boundary

When Runtime Worker loads a Run, it may select the Team-scoped tool runtime only if:

1. the binding is present and structurally valid;
2. tenant and space match the Worker route;
3. the referenced Team task and capability snapshot are still readable;
4. the current execution lease is valid;
5. the selected tool adapter explicitly supports the binding.

Missing, stale or mismatched binding returns a permanent authority error. Ordinary Runs continue using the existing AgentVersion runtime path.

## Compatibility and migration

The field is nullable for historical Runs. Existing Run/queue/event public projections remain unchanged until a separate contract review approves a public view. SQLite and PostgreSQL migrations must be additive, and old rows must not be inferred from thread names, effects or message text.

## Verification order

1. Add internal storage/parser coverage for nullable binding and corruption rejection.
2. Add atomic Run admission/replay/rollback coverage for SQLite and PostgreSQL.
3. Make Runtime Worker resolve the binding without changing the ordinary tool catalog.
4. Add a Team-only tool adapter fixture and verify parent fence, approval, retry and child result replay.
5. Run durable Team UI acceptance and reconnect/cancel tests before enabling any model-visible spawn tool.

Until this binding exists, the host-only admission, child reader and waiter remain internal preparation; no generic Worker Run should expose autonomous spawn.
