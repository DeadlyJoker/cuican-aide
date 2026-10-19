# Team-scoped autonomous spawn contract

This contract is the next boundary for model-triggered autonomous children. It is intentionally separate from the generic `ToolRuntimePort`.

## Request

The Team-scoped tool accepts only the captured `AutonomousTaskChildSpawnRequest` shape:

- `schemaVersion`
- `idempotencyKey`
- `parentTaskId`
- `childTaskId`
- `edge`
- `budget`
- `capability`
- `childIntent`

`parentCapability` and `parentFence` are never accepted from the model or tool input. `captureAutonomousTaskChildSpawnRequest` rejects accessors, unknown keys, forged authority fields, mismatched identities, depth/child-budget overflow, and child intent scope drift.

## Host binding

The Team executor host must bind the captured request to its current lease fence:

1. Verify the fence belongs to the coordinating parent task.
2. Copy and freeze the host capability snapshot.
3. Inject that snapshot as `parentCapability`.
4. Submit the complete admission to `TeamTaskJournalStore.admitAutonomousChild`.
5. Return only the durable admission result and edge; never return an optimistic child identity.

The Store transaction remains authoritative for the parent effect, child task, edge, metadata and wake marker. Replays use the same idempotency key and compare the full frozen request.

## Tool policy

The future tool must use a distinct Team-scoped capability, for example `team.autonomous.spawn.v0`, with:

- mutation effect;
- reconcilable recovery;
- per-action approval according to the parent Run policy;
- execution target bound to the current Team host;
- resource binding to the parent Team task;
- bounded input and output limits.

The tool must be created only inside a Team executor that has both the parent fence and the host admission port. A generic Worker Run, browser client, HTTP request, or arbitrary `ToolRuntimePort` instance must not expose it.

## Result observation

After admission, the parent may use the host-only child reader/waiter:

- snapshots are read from one SQLite/PostgreSQL journal snapshot;
- child IDs are bounded and returned in caller order;
- `finalAccepted` or durable `cancelRequested` are the only settled observations;
- missing children, deadline expiry and cancellation fail closed.

The parent does not mutate child state through this read port. Cancellation remains a separate durable tree operation.

## Rollout order

1. Implement a Team-scoped tool adapter that receives an explicit host port and exposes only this definition.
2. Bind its action intent to the parent Run policy and Team fence.
3. Add a real model/tool fixture that requests one child, loses the admission response, and retries the same idempotency key.
4. Verify SQLite and PostgreSQL admission/replay/rollback, child scheduler execution, parent cancellation, deadline expiry and bounded result wait.
5. Keep the adapter behind an explicit feature gate until a real UI/Worker acceptance covers approval, refresh, reconnect and final result display.

Until these steps are complete, the current host-only admission/reader/waiter ports remain internal preparation and the generic model tool catalog stays unchanged.
