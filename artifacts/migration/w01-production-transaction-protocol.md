# W01 production transaction protocol

Status: frozen for implementation. Production Workflow composition remains fail closed until every
transaction below has real SQLite conformance and the applicable PostgreSQL/cross-process checks.

## Global authority rules

- `WorkflowRuntimeStore` is one non-splittable physical transaction authority for Workflow start,
  scheduler fan-out, node admission/settlement, dispatch evidence, continuation, Human Gate,
  reconciliation, cancellation, and terminal convergence.
- Every mutating operation is receipt-first. An exact replay is observation-only; fingerprint or
  durable-state disagreement fails closed as receipt corruption.
- Only `admitWorkflowNodeWork(...).disposition === "fresh"` carries an `admission` and grants model
  or Tool execution permission. `replay` and `reconcileRequired` always carry `admission: null`.
- Scheduler output grants no model or Tool execution permission. It may only publish durable node
  WorkItems and gate publications. Scheduler receipt replay returns empty side-effect authorities.
- Every Agent/Verification node executes under its own node WorkItem lease. A scheduler lease must
  never execute a node or be shared by sibling nodes.
- A running lease that expires becomes unknown/reconciliation work. It never becomes pending again.
- Worker reports Workflow completion only when Store returns `runDisposition: "terminalConverged"`.
  A terminal `workflow_execution.status` alone is not canonical Run completion evidence.
- After a Store mutation returns an unknown result, Worker must not perform another mutation with
  the possibly consumed lease. It schedules or claims durable reconciliation instead.

## Atomic transactions

### 1. Workflow Start

Receipt-probe before mutable reads. In one fresh transaction: validate tenant/space/thread, load and
digest-check the immutable WorkflowVersion, validate canonical root input against frozen
`inputSchema`, validate every frozen AgentVersion/release/route binding, create `purpose=workflow`
Run with `{workflowId, workflowVersionId, contentDigest}`, persist the root value/reference, create
the scheduler WorkItem, and write the canonical Run event, snapshot, outbox, and receipt. Replay
returns the exact committed authority and invokes neither route resolution nor preparation.

### 2. Scheduler Fan-out

Validate the exact scheduler WorkItem lease; lock canonical Run, frozen binding, root value, and DAG
revision. Compute ready nodes in immutable `executionOrder`. For every ready Agent/Verification node
create one deterministic node WorkItem and leave DAG state `queued`; for Human Gate create the
durable gate request, waiting Step, publication outbox, and deterministic resume identity. Persist
the new DAG revision, complete the scheduler WorkItem, and write the receipt atomically. Recovery
creates/reuses reconcile WorkItems before completing the scheduler WorkItem. Replay returns empty
`nodeWorkItems`, `gatePublications`, and `reconciliationClaims`.

### 3. Node Admission

Validate the node WorkItem's own exact lease plus nodeId, claimId/epoch, frozen binding, scheduler
operation, and canonical input reference. Derive node AgentVersion only from immutable WorkflowVersion
and durable DAG state. In one transaction create the exact RunStep/RunAttempt, move only that node
from `queued` to `running`, and write the receipt. Only fresh returns the admission/input/Step/Attempt.
Replay returns `admission: null`; an expired or ambiguous running attempt becomes reconcileRequired.

### 4. Node Settlement

Receipt-probe, then validate the exact node WorkItem lease, DAG claim, AgentVersion, Step/Attempt,
dispatch receipt/revision, continuation revision, and terminal evidence. Store validates output
against the frozen node schema and derives canonical JSON, digest, and value reference. In one
transaction terminate dispatch/continuation, Attempt, Step, and DAG node; create/reuse the unique
continuation scheduler WorkItem when new nodes may be ready; converge canonical Run when terminal;
complete the node WorkItem; write Run event/snapshot/outbox and settlement receipt. Possibly-sent
without response evidence cannot settle as a deterministic model outcome.

### 5. Human Gate

Gate request, waiting Step, publication outbox, approval identity, and resume WorkItem identity are
durable before publication. Scheduler releases its WorkItem in the same transaction and never waits
for lease expiry. Approve/reject writes one durable decision receipt and creates/reuses the independent
resume WorkItem. Resume settlement atomically terminates the gate Step/DAG node, creates/reuses the
continuation scheduler WorkItem, completes the resume WorkItem, and converges the Run when terminal.
Replay never republishes or resumes twice.

### 6. Reconciliation

Use stable operation/receipt identity. Create/reuse durable reconcile work before completing the old
WorkItem. `notDispatched` may authorize a new fresh attempt only through a new node admission;
`possiblySent` must reconcile and never blindly execute; `responseObserved` may settle using exact
evidence; `terminal` replays the committed outcome. Unknown/completed/failed/canceled transitions
are explicit and late evidence cannot overwrite a terminal Run or canceled DAG.

### 7. Workflow terminal convergence and cancellation

In one transaction converge terminal DAG/Verification result, all affected Step/Attempt states,
canonical Run event/snapshot/outbox, current WorkItem, and operation receipt. Cancellation handles
queued, running, waitingHuman, and unknown nodes: deterministic unsent work may cancel immediately;
possibly-sent work creates/reuses reconciliation before the current WorkItem completes. Late outcome
cannot overwrite canceled. Only an exact `terminalConverged` result authorizes Worker completion.

## Production prohibition

Production export/composition remains disabled when any method is absent, throws
`workflow_composition_contract_incomplete`, is backed only by a mock/conditional skip, or is supplied
by a different Store instance. No fake adapter may be used to claim an end-to-end slice.

## W01 acceptance matrix (2026-08-13)

| Capability | Status | Current evidence / gap |
| --- | --- | --- |
| transaction contract | 通过 | this protocol plus discriminated Application ports |
| Workflow Start | 通过（SQLite Control） | real HTTP Control admission uses the certified `SqliteRunStore`; public RunView/audit events prove queued→running→terminal, and exact Application replay remains covered |
| Scheduler fan-out | 通过（SQLite Slices 1–2） | real Worker persists `run.started`; two-connection Slice 2 creates frozen-order sibling WorkItems with distinct claims and no scheduler Attempt |
| Node admission | 通过（SQLite Slices 1–2） | two real Workers hold distinct sibling leases and simultaneously running Steps/Attempts; mock adversarial suite separately covers replay and response-loss fencing |
| Node settlement | 通过（SQLite Slices 1–2） | siblings settle right-before-left without authority reuse; Verification appears only after both dependencies terminate and receives frozen-order input |
| Human Gate | 通过（SQLite Control） | strict public decision API plus real certified Worker proves approve→Verification→completed and reject→failed; internal receipt/resume authority is not exposed |
| Reconciliation | 通过（TS SQLite Slice 4） | real second-connection Worker restart covers `possiblySent`, `notDispatched`, checkpoint-only `responseObserved`, and Store-owned terminal candidates. Candidate recovery settles from frozen schema authority with one model sample; exact receipt replay is observation-only and mismatched candidate IDs fail closed |
| Terminal convergence | 通过（TS SQLite Slices 1–5） | success、Verification、gate、reconcile 与 cancel 均由 Store 单事务收敛；queued、running/notSent、waitingHuman、unknown/possiblySent 以及 responseObserved late outcome 已覆盖，provider 终态仅保留审计证据且不能覆盖 canceled canonical DAG/Step/Attempt/Run |
| PostgreSQL real-host | 未验证 | focused real-host checks passed, but Slice 6 dual-process acceptance has not |
| Packaged crash recovery | 未验证 | no packaged Workflow vertical acceptance |
| Rust compatibility | 不适用（纯 TS 迁移边界） | migration uses the TS runtime only; Rust is not used during migration, and no compatibility layer, dual-write, fallback, or parity gate will be built; only a hard TS build dependency may receive minimal decoupling |
