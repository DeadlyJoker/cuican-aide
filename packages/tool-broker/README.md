# CrewON Tool Broker

`@crewon/tool-broker` owns the provider-neutral Tool Catalog and Worker-side
`execute/reconcile/cancel` boundary. The Agent Kernel can read definitions but cannot execute a Tool.
The package does not depend on an OpenAI SDK, MCP SDK, shell implementation, or a closed runtime.

Current guarantees:

- strict bounded Tool definitions, invocations, results, and JSON schemas;
- stable execution IDs, Action Digests and idempotency keys with conflicting reuse rejected;
- every Provider command carries the durable Work Item, Step/Attempt, lease ID/epoch and database-derived expiry needed by a
  remote execution boundary; malformed lease identity fails before dispatch;
- canonical ActionIntent revalidation across input, policy, workspace, resource, credential, target, capability and limits;
- every per-action Provider command requires a persisted Approval proof bound to the same Action Digest and policy snapshot;
- caller cancellation propagated through `AbortSignal`;
- unknown and failed Tools become bounded model-visible results without leaking backend errors;
- explicit resolved `serial` or `parallel` execution policy;
- process output remains plain text and preserves exit code, wall time, and output;
- the Worker keeps raw output behind an optional artifact reference and sends at most about 10K
  tokens (40KB) back to the model;
- mutation definitions require an explicit reconcilable policy; missing policy fails closed.

`InMemoryToolBroker` is a deterministic Catalog/Provider adapter. Its provider receipt cache is
process-local, while durable execution receipts live in the Run Store. After provider restart it
replays only `readOnly + replaySafe` calls; an unprovable mutation returns `unknownOutcome`. It is
safe for parity and recovery tests but is not the production authority for shell, MCP, Device, or
other side effects. Production composition defaults to no Tool definitions. Such Tools remain
unavailable until a real reconciliation adapter and policy/approval path are connected. The separate open MCP runtime now
provides a real stdio path for explicitly configured read-only, replay-safe tools only.
