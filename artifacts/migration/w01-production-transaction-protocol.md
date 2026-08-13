# W01 production transaction protocol

Status: accepted for the TypeScript runtime. Control and Worker now construct Workflow services
directly from one physical SQLite or PostgreSQL Store implementing every transaction below; there
is no optional candidate/certification composition path.

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

## Production gate

SQLite and PostgreSQL production composition is structurally bound to their canonical
`DomainStore`; Control constructs Workflow start/Human Gate services from that Store, and Worker
unconditionally constructs the production dispatcher from the same Store it uses for Run execution.
There is no public disabled/candidate gate, second pool/Store, fake adapter, or certification switch.
An incomplete Store therefore fails at construction/typecheck instead of silently omitting Workflow.

## W01 acceptance matrix (2026-08-13)

| Capability              | Status                       | Current evidence / gap                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| transaction contract    | 通过                         | this protocol plus discriminated Application ports; obsolete optional certification/candidate gates were removed from Control and Worker                                                                                                                                                                                                                                                                                                                                     |
| Workflow Start          | 通过（SQLite Control）       | real HTTP Control admission uses the canonical `SqliteRunStore`; public RunView/audit events prove queued→running→terminal, and exact Application replay remains covered                                                                                                                                                                                                                                                                                                     |
| Scheduler fan-out       | 通过（SQLite Slices 1–2）    | real Worker persists `run.started`; two-connection Slice 2 creates frozen-order sibling WorkItems with distinct claims and no scheduler Attempt                                                                                                                                                                                                                                                                                                                              |
| Node admission          | 通过（SQLite Slices 1–2）    | two real Workers hold distinct sibling leases and simultaneously running Steps/Attempts; mock adversarial suite separately covers replay and response-loss fencing                                                                                                                                                                                                                                                                                                           |
| Node settlement         | 通过（SQLite Slices 1–2）    | siblings settle right-before-left without authority reuse; Verification appears only after both dependencies terminate and receives frozen-order input                                                                                                                                                                                                                                                                                                                       |
| Human Gate              | 通过（SQLite Control）       | strict public decision API plus real certified Worker proves approve→Verification→completed and reject→failed; internal receipt/resume authority is not exposed                                                                                                                                                                                                                                                                                                              |
| Reconciliation          | 通过（TS SQLite Slice 4）    | real second-connection Worker restart covers `possiblySent`, `notDispatched`, checkpoint-only `responseObserved`, and Store-owned terminal candidates. Candidate recovery settles from frozen schema authority with one model sample; exact receipt replay is observation-only and mismatched candidate IDs fail closed                                                                                                                                                      |
| Terminal convergence    | 实现完成，PG 实机复验待执行 | success、Verification、gate、reconcile 与 cancel 均由 Store 单事务收敛。并行取消已拆成 node-owned lane 与 dedicated cancellation coordinator：每个 running sibling 只由自己的 WorkItem lease 结算，possiblySent/responseObserved 各自产生 deterministic reconcile authority，coordinator 对 foreign lease 返回 retained/retryRequired，不能越权结算 sibling。SQLite 双 running sibling 回归已通过；PostgreSQL 同构实现已 typecheck，但当前环境没有 `CREWON_TEST_POSTGRES_URL`，须在 real host 重跑后恢复为完全通过 |
| PostgreSQL real-host    | 通过                         | real PostgreSQL ran the complete Store suite (556 pass, 0 fail; one unrelated Provider skip), Worker suite (355/355), and Control suite (112/112). One `PostgresDomainStore` now owns Run, Attempt, dispatch evidence, Workflow composition, and terminal convergence; the public production Control→Worker→Agent→Verification vertical completed with two Attempts. Earlier two-process/SIGKILL tests also preserved lease epochs and unique receipt/continuation authority |
| Packaged crash recovery | 通过                         | packaged `.app` uses the TS Control/Worker runtime and one-shot TS Release bootstrap, with no Gateway, Device, or app-server process: after Worker and GUI `SIGKILL`, guardian cleared the process tree and the same HOME resumed Agent→Verification to one canonical `run.completed`; two distinct node requests produced exactly two Attempts with no repeated model side effect                                                                                           |
| Control Workflow UI     | 通过（Slice 1 public surface） | tenant-wide immutable WorkflowVersion discovery、definition read、JSON input、Run start、client SSE、canonical Run read、cancel 与 output reference 已接入 Command Team；旧 App Server/local Workflow list/create/run/Gate/notification compatibility chain 已从 production composition 删除。公共契约尚未提供 Gate claim authority 或 node output view，因此 UI 不伪造这些能力                                                                                         |
