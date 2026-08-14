# W01 production transaction protocol

Status: accepted for the TypeScript runtime. Control and Worker now construct Workflow services
directly from one physical SQLite or PostgreSQL Store implementing every transaction below; there
is no optional candidate/certification composition path.

## Global authority rules

- `WorkflowRuntimeStore` is one non-splittable physical transaction authority for Workflow start,
  scheduler fan-out, node admission/settlement, dispatch evidence, continuation, Human Gate,
  per-action Tool approval publication/resume, reconciliation, cancellation, and terminal
  convergence.
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

An Agent node's per-action Tool approval uses the same rules with its own deterministic resume
WorkItem. Publication requires the prepared Tool receipt and exact continuation revision, commits
the approval, waiting Run event/snapshot/outbox and completes the Agent node WorkItem in one
transaction. A terminal decision wakes only the resume WorkItem. Consumption atomically adopts the
Agent Attempt, Tool Attempt, Tool receipt and continuation checkpoint to the resume lease epoch.
Worker reconstructs pending calls from durable Run events scoped to that exact continuation
segment; approval replay never resamples the pre-approval model segment or blindly executes an
unknown Tool receipt. After an approved Tool commits, the same Agent Attempt may replace its
provider checkpoint only under the next exact model-dispatch receipt, and a reclaimed approval
WorkItem resumes from the durable completed Tool continuation without repeating the Tool effect.

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
cannot overwrite canceled. A dedicated cancellation coordinator is the only authority allowed to
write canonical `run.canceled`; while any sibling remains queued/running/unknown/waitingHuman it
returns the typed `retryRequired` + retained handoff without a final receipt. A reclaimed node lease
may settle an older Attempt only for the same WorkItem after the current lease is validated, and
dispatch termination remains fenced by the older Attempt authority. Only an exact
`terminalConverged` result authorizes Worker completion.

## Production gate

SQLite and PostgreSQL production composition is structurally bound to their canonical
`DomainStore`; Control constructs Workflow start/Human Gate services from that Store, and Worker
unconditionally constructs the production dispatcher from the same Store it uses for Run execution.
There is no public disabled/candidate gate, second pool/Store, fake adapter, or certification switch.
An incomplete Store therefore fails at construction/typecheck instead of silently omitting Workflow.

## W01 acceptance matrix (2026-08-14)

| Capability                 | Status                         | Current evidence / gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| transaction contract       | 通过                           | this protocol plus discriminated Application ports; obsolete optional certification/candidate gates were removed from Control and Worker                                                                                                                                                                                                                                                                                                                                                                                                        |
| Workflow Start             | 通过（SQLite Control）         | real HTTP Control admission uses the canonical `SqliteRunStore`; public RunView/audit events prove queued→running→terminal, and exact Application replay remains covered                                                                                                                                                                                                                                                                                                                                                                        |
| Scheduler fan-out          | 通过（SQLite Slices 1–2）      | real Worker persists `run.started`; two-connection Slice 2 creates frozen-order sibling WorkItems with distinct claims and no scheduler Attempt                                                                                                                                                                                                                                                                                                                                                                                                 |
| Node admission             | 通过（SQLite Slices 1–2）      | two real Workers hold distinct sibling leases and simultaneously running Steps/Attempts; mock adversarial suite separately covers replay and response-loss fencing                                                                                                                                                                                                                                                                                                                                                                              |
| Node settlement            | 通过（SQLite Slices 1–2）      | siblings settle right-before-left without authority reuse; Verification appears only after both dependencies terminate and receives frozen-order input                                                                                                                                                                                                                                                                                                                                                                                          |
| Human Gate                 | 通过（SQLite Control）         | strict public decision API plus real certified Worker proves approve→Verification→completed and reject→failed; internal receipt/resume authority is not exposed                                                                                                                                                                                                                                                                                                                                                                                 |
| Agent Tool approval        | 通过（SQLite Control→Worker）  | 公共 Control/UI 复用通用 Tool approval 决策 API；真实 Control HTTP→SQLite Store→production Worker 纵向验收分别覆盖 approve、reject、expire、cancel，并在 approval publication 后关闭旧 Worker、由新 Worker 接管 resume authority。approve 仅执行一次 Tool effect，继续同一 Agent Attempt 的下一 model round 后进入 Verification；其余三条均为零 Tool execution。Store/Worker 另覆盖 exact replay、resume lease adoption、completed receipt crash-window、segment sibling 隔离，以及 unknown receipt 只 reconcile 不 execute。                   |
| Reconciliation             | 通过（TS SQLite + PostgreSQL） | SQLite 多 Worker 纵向验收覆盖两个 `responseObserved` sibling、coordinator retained/retry、node lease epoch 2 回收、两个独立 reconcile authority、零重复采样与最终 idle。真实 production-main PostgreSQL 16 验收在 Agent `response.created` 已持久化后 `SIGKILL` Worker；新 Worker 复用原 Attempt/dispatch authority，只执行一次 `GET /v1/responses/{responseId}` 并原子结算，精确计数为 Agent POST=1、retrieve GET=1、Verification POST=1。`possiblySent`、`notDispatched`、terminal candidate replay 与 GET 非终态禁止续发 POST 均有独立回归。 |
| Terminal convergence       | 通过                           | success、Verification、gate、reconcile 与 cancel 均由 Store 单事务收敛。并行取消使用 node-owned lane 与 dedicated cancellation coordinator：每个 running sibling 只由自己的 WorkItem lease 结算，coordinator 对 foreign lease 返回 retained/retryRequired 且不写最终 receipt；两个 reconcile 均完成后才产生唯一 `run.canceled`。SQLite 纵向验收断言无 live Attempt、无 active/stranded WorkItem、无 Verification Attempt，模型 dispatch 总数保持 2。                                                                                            |
| PostgreSQL real-host       | 通过                           | 2026-08-14 当前 HEAD 在一次性 PostgreSQL 16 上完成 Store `567 total / 566 pass / 1 inverse skip / 0 fail`。另有严格 production-main 纵切实际启动 Control main、release-main、崩溃前后两个 Worker main、HTTPS Identity/Policy、Provider 与 Workspace authority；所有进程连接同一 PG schema，Agent POST=1、retrieve GET=1、Verification POST=1，Run 与两个 Attempt 均 completed。覆盖 receipt replay、双连接竞争、并行取消、multi-reconcile、reclaimed Attempt authority 与子进程 `SIGKILL`，不是条件 skip 或 mock Store。                        |
| Packaged crash recovery    | 通过                           | 2026-08-14 当前 HEAD 重建 unsigned `.app` 后真实运行。Control client start/read 与 client-view SSE 证明 Agent→Human Gate→Verification 和唯一 `run.completed`；相同 start key 返回 `committed -> replayed`、同一 runId，SQLite admission receipt=1、canonical Run=1。杀死 Worker 与 GUI 后 guardian 清理进程树并释放 Control 端口；同一 HOME 重启后 gate decision replay、原 Run terminal，模型调用总数=2（Agent 与 Verification 各一次）、Attempt=2。产物扫描只含 GUI、官方 Node 24、guardian 和四个 TS bundle。                                |
| Rust production dependency | 不适用（纯 TS cutover）        | 按迁移决策不再实现或验证 Rust Runtime/App Server/Device/Gateway parity、fallback、dual-write 或 packaged compatibility。桌面仅保留 Tauri 壳与 `crewon-process-guardian`；bundle manifest 精确限制为官方 Node 24、guardian 和 Control/Provider coordinator/Release/Worker 四个 TypeScript runtime resource。                                                                                                                                                                                                                                     |
| Control Workflow UI        | 通过（Slice 1 public surface） | tenant-wide immutable WorkflowVersion discovery、definition read、JSON input、Run start、client SSE、canonical Run read、cancel 与 output reference 已接入 Command Team；同一 start 尝试在响应未知时保留 idempotency key，只有 authoritative response 或输入/thread/version 改变后才轮换。旧 App Server/local Workflow compatibility chain 已删除；公共契约尚未提供 Gate claim authority 或 node output view，UI 不伪造这些能力。                                                                                                               |
