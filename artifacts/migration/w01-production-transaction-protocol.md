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
- Model-visible Workflow context is projected once into durable bounded values: every item is at
  most 10,000 UTF-8 bytes, node input uses at most 64 lossless fragments of at most 8 KiB each,
  and oversized assistant/Tool text is deterministically truncated before persistence. Recovery
  reuses that projection and never injects an unbounded raw receipt into model history.

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
`possiblySent` must never blindly execute: cancellation records `abandonedPossiblySent`, while a
non-canceled request without a provider locator/idempotency proof is atomically terminated as
`operatorRequired` with the public code `workflow_model_dispatch_operator_required`; the current
reconcile WorkItem is completed and is never retried. `responseObserved` may settle using exact
evidence. If retrieve returns a legal nonterminal response, Store atomically appends only the missing
canonical event suffix, terminates the consumed dispatch, adopts the parent Attempt/node/checkpoint
and pending Tool authorities to the reconcile lease, and returns `resumeRequired` without completing
the WorkItem. A committed continuation is replayed from Store without another GET or POST. `terminal`
replays the committed outcome. Unknown/completed/failed/canceled transitions are explicit and late
evidence cannot overwrite a terminal Run or canceled DAG.

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

## W01 acceptance matrix (2026-08-19)

| Capability                 | Status                               | Current evidence / gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| transaction contract       | 通过                                 | this protocol plus discriminated Application ports; obsolete optional certification/candidate gates were removed from Control and Worker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Workflow Start             | 通过（SQLite Control）               | real HTTP Control admission uses the canonical `SqliteRunStore`; public RunView/audit events prove queued→running→terminal, and exact Application replay remains covered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Scheduler fan-out          | 通过（SQLite + PostgreSQL）          | real Worker persists `run.started`; two-connection tests create frozen-order sibling WorkItems with distinct claims and no scheduler Attempt. PostgreSQL reverse settlement proves no continuation after the first sibling and exactly one after the second.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Node admission             | 通过（SQLite + PostgreSQL）          | independent Workers/connections hold distinct sibling leases and running Steps/Attempts. Replay, response-loss fencing and terminal Run historical validation are covered without granting a second execution admission.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Node settlement            | 通过（SQLite + PostgreSQL）          | siblings settle right-before-left without authority reuse; Verification appears only after both dependencies terminate, receives frozen-order input, and each terminal node writes one canonical audit event/outbox message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Human Gate                 | 通过（SQLite + PostgreSQL）          | Gate publication is a dedicated bounded public authority: Store atomically changes `publicationPending -> published` and ACKs the exact Outbox lease. Real PostgreSQL Control→Outbox→public query→decision→Worker restart→Verification covers authorization denial, publication, exact decision replay and unique terminal convergence without private database reads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Agent Tool approval        | 通过（SQLite Control→Worker）        | 公共 Control/UI 复用通用 Tool approval 决策 API；真实 Control HTTP→SQLite Store→production Worker 纵向验收分别覆盖 approve、reject、expire、cancel，并在 approval publication 后关闭旧 Worker、由新 Worker 接管 resume authority。approve 仅执行一次 Tool effect，继续同一 Agent Attempt 的下一 model round 后进入 Verification；其余三条均为零 Tool execution。Store/Worker 另覆盖 exact replay、resume lease adoption、completed receipt crash-window、segment sibling 隔离，以及 unknown receipt 只 reconcile 不 execute。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Reconciliation             | 通过（SQLite）；PG 待 real-host 复验 | assistant/完整 Tool continuation、未完成 Tool receipt/Attempt，以及 retrieve 返回的合法 nonterminal continuation 都由 Store 以 `resumeRequired` 原子采用。真实 SQLite Worker close/reopen 证明：已消费 response 只 GET 一次，commit 返回丢失后重开不再 GET，恢复下一模型 round 后进入 Verification；pending Tool 路径 external execute=`1`、reconcile=`1`、Attempt 数量=`1`、唯一 `tool.completed`。无 provider locator/idempotency 的 `possiblySent` 不再无限 retry：SQLite/PostgreSQL 原子写 `failed/operatorRequired` dispatch、failed Node/Step/Attempt、completed reconcile WorkItem、节点事件/outbox 与 composition receipt；terminal Run 使用精确公开 code，并行 sibling 保留其独立 lease。真实 SQLite Store+Worker 重启纵向证明 model POST=`1`、reconcile 后再次 wake=`idle`，公开 Run code 与全部 authority 精确终结；replay 会重验 receipt、dispatch、Attempt、Step、WorkItem、节点事件及 terminal Run/outbox。PostgreSQL 对等 transaction/replay 代码与条件矩阵已落，本机当前无 `CREWON_TEST_POSTGRES_URL`，不把 65 个条件 skip 记为 real-host 通过。 |
| Terminal convergence       | 通过                                 | success、Verification、gate、reconcile 与 cancel 均由 Store 单事务收敛。并行取消使用 node-owned lane 与 dedicated cancellation coordinator；`possiblySent` 在用户取消后只能以显式 `abandonedPossiblySent` certainty 终止，晚到结果不能覆盖终态。PostgreSQL 还覆盖两个 Agent sibling 在独立连接上反序结算：只创建一个 continuation scheduler，Verification 按冻结顺序读取输入，三个节点均有唯一 terminal event，Run 终态后 replay 仍精确验证。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| PostgreSQL real-host       | 既有纵向通过；本轮增量待复验         | 既有 PostgreSQL 16 串行 Store、cross-process `SIGKILL`、sibling 反序结算、Gate、cancel、reconcile、downstream-completed receipt replay、schema migration，以及 production Control/Release/Worker 崩溃纵向都曾实际执行。2026-08-19 本轮新增 retrieved-nonterminal 与 `operatorRequired` PG transaction/replay 条件矩阵因当前环境没有 `CREWON_TEST_POSTGRES_URL` 而明确跳过；合并后的本地 Store 为 `383 pass / 65 conditional skip / 0 fail`，不能将这些 skip 外推为最新 HEAD 的 real-host 通过。PG 契约门禁仍须串行，避免共享 advisory-lock 测试彼此污染。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Packaged crash recovery    | 通过                                 | 2026-08-19 当前 HEAD 重建 unsigned `.app` 后真实运行 Run `01a018e5-f009-765f-98b5-f188e1c78e7c`。Control client/SSE 证明 Agent→Human Gate→Verification 和唯一 `run.completed`；start 为 `committed -> replayed`，Gate 决策为 `recorded -> replay`，admission receipt=1、canonical Run=1、model samples=2、Attempts=2。Worker 与 GUI `SIGKILL` 后 guardian 都清理完整进程树并释放 3210/6176。产物仅含 GUI、官方 Node 24.18.1（SHA-256 `f480…ff5`）、guardian 和四个 TS bundle，removed-marker scan 为 0。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Rust production dependency | 不适用（纯 TS cutover）              | 按迁移决策不再实现或验证 Rust Runtime/App Server/Device/Gateway parity、fallback、dual-write 或 packaged compatibility。桌面仅保留 Tauri 壳与 `crewon-process-guardian`；bundle manifest 精确限制为官方 Node 24、guardian 和 Control/Provider coordinator/Release/Worker 四个 TypeScript runtime resource。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Control Workflow UI        | 通过（public surface）               | immutable WorkflowVersion discovery/definition, JSON input, Run start, client SSE, canonical Run read, cancel, output reference and bounded published Human Gate query/decision are wired to Command Team. Unknown start keeps the same idempotency key. The legacy App Server/local Workflow chain is deleted; node output detail beyond the public Run projection remains intentionally unavailable rather than fabricated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
