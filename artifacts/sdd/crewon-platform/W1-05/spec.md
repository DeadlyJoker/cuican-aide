# W1-05 Specification: Task Runtime 纯领域

## 1. 目标

本阶段建立最小 `crewon-task-runtime` 纯领域 crate，为 Durable Cloud Agent 和 Office 提供唯一 Task Authority、确定性状态机、Attempt/Lease/Fencing、Inbox/Outbox 原子提交契约和 transport-neutral Worker port。

普通本地单聊继续以 Core Thread/Turn 为权威，不进入本 Task Runtime。Workflow、Experts、Automation、Approval、Artifact、Context 构造和具体 Provider adapter 均由后续 Wave 接入。

## 2. 现状与权威边界

- `crewon-cloud-tasks-client` 是现有 Codex Cloud Tasks 产品客户端，状态和 API 语义与 CrewON 中台 Task 不同；不得复用为新 Authority。
- Office 当前在 app-server JSON/processor 中保存 dispatch lease 等临时状态；本阶段不读写或双写这些记录。
- app-server v2 canonical contract 已定义粗粒度 Task ref vocabulary；领域模型可以更严格，W1-10 由 adapter 显式映射。
- Task Store 是唯一 Task/Event/Snapshot authority；Thread Rollout、Provider Run、Office 消息和 Artifact 各自继续保存完整事实，不复制进 Task payload。

## 3. 第一版闭集

> W2-07 prerequisite amendment（2026-07-21）：在生产 Task consumer 接线前，Task Contract schema 提升并限定为 v2，新增 metadata-only `ExecutionSpecRef`（ID/revision/digest）。Contract 现在 canonicalize resource binding 顺序、自行计算 SHA-256 hash，并在 snapshot restore 时重算比较；WorkerDispatch 同步携带该引用。prompt/context/Credential/Secret 仍不进入 Task Aggregate。

### 3.1 Authority

`TaskAuthority` 只有：

- `LocalAppServer`
- `CloudTaskControl`

Authority 写入不可变 `TaskContract`，Task 生命周期内不能改变。每个 Command 必须声明执行它的 Authority，领域层与 Aggregate 中的 Authority 完整比较；不匹配直接拒绝。

### 3.2 StrategyKind

第一版只包含真实首批消费者：

- `Single`：仅指需要 Durable Provider Run 的云 Agent Task；不包含普通本地单聊。
- `Office`：Leader/成员协作 Task。

不提供动态 registry、字符串扩展或空的 Workflow/Experts/Automation strategy。后续只有在相应 Aggregate SDD 落地时扩展闭集。

### 3.3 Task Contract

不可变 Contract 至少包含：

- bounded Task ID、Authority、StrategyKind、WorkspaceKey。
- schema version 和 canonical SHA-256 contract hash。
- 有上限的 `ResolvedResourceBinding` 列表。
- created timestamp。

修改目标、Authority、Workspace 或资源版本必须创建派生 Task，不能原地覆盖 Contract。

## 4. Aggregate 与状态机

### 4.1 TaskStatus

```text
Created -> Queued -> Running <-> Suspended
                         |          |
                         v          v
                    Reconciling   Queued (Authority retry)
                         |
                         v
              Completed | Failed | Cancelled
```

精确定义：

- `Created`：Contract 已建立，尚未接受执行。
- `Queued`：Authority 已创建一个 Attempt，等待 claim/dispatch。
- `Running`：当前 Attempt 已由有效 Lease 的 Worker 执行。
- `Suspended`：等待 Provider resume、人工条件或 Authority retry/final-failure 决策。
- `Reconciling`：当前 Attempt 的 Provider 结果未知，只允许读取同一 Provider Run 并归并结果。
- `Completed | Failed | Cancelled`：不可回退终态。

### 4.2 AttemptStatus

```text
Created -> Started <-> Suspended
                    -> Unknown -> Succeeded | Failed | Cancelled
                    -> Succeeded | Failed | Cancelled
```

- Authority 在 `AcceptTask` 或 `ScheduleRetry` 时创建 Attempt。
- Executor 不得创建 Attempt、改变 ordinal 或选择 retry。
- Worker failure 先把 Attempt 标为 `Failed`，Task 进入 `Suspended(RetryDecision)`；Authority 随后只能二选一：创建下一 Attempt，或把 Task 裁决为最终 `Failed`。
- Unknown outcome 把 Task 置为 `Reconciling`；禁止创建新 Attempt，直到同一 Worker/Provider Run 返回可确认终态。

### 4.3 Suspend/Resume

`SuspensionReason` 首版闭集：

- `ProviderPaused`
- `ApprovalRequired`
- `RetryDecision`

只有 `ProviderPaused` / `ApprovalRequired` 可以由同一 Attempt 的有效 Worker event 恢复；`RetryDecision` 只能由 Authority 的 `ScheduleRetry` 或 `FailTask` 结束。

## 5. Command、Event 与 Reducer

### 5.1 Command

`TaskCommandEnvelope` 固定 Command ID、Task ID、Authority、received timestamp 和闭集 Command：

- `AcceptTask`
- `ClaimAttempt`
- `ReclaimAttempt`
- `ApplyWorkerEvent`
- `CancelTask`
- `ScheduleRetry`
- `FailTask`

Command decision 是纯函数，返回 proposed Task events 和 `SchedulerDecision`；不做 I/O、不分配数据库 offset、不执行 Worker。

### 5.2 Worker event

每个 Worker event 固定：

- Event ID、Task/Attempt/WorkerRun ID。
- producer sequence。
- lease epoch 和 fencing token hash。
- occurred/received timestamp。
- `Progressed | Suspended | Resumed | Succeeded | Failed | OutcomeUnknown` 闭集。

Worker payload 不携带无限 transcript、任意 JSON、Secret 或 retry 指令。

### 5.3 Authority event 与 Event envelope

Authority events 固定 Task accepted、Attempt claimed/reclaimed、retry scheduled、Task cancelled/final failed。Domain 根据当前 Snapshot 计算唯一的 `lastOffset + 1`，Store 在 expected-version CAS 成功的同一事务中验证并提交该 offset、event、snapshot、Inbox receipt 和 Outbox records。

Reducer 只接收带 stream offset 的 committed event：

- 必须与 Task ID 一致。
- 新 event offset 必须是 `last + 1`。
- 同一 Event ID 与同一 offset 重放是 no-op；其他旧 offset 或 gap 拒绝。
- 核心 match exhaustive；无 unknown/default 状态推进。

## 6. Lease、Fencing 与顺序

- `LeaseGrant` 固定 `leaseEpoch`、`FencingTokenHash` 和 `expiresAt`。
- Domain 只保存/比较 token hash，不接收或持久化原始 token。
- 初次 claim 的 epoch 必须为 1；reclaim 必须在旧 Lease 已过期后使用严格递增 epoch。
- 当前 Worker event 必须同时匹配 Attempt ID、WorkerRun ID、lease epoch 和 token hash，并且 `receivedAt <= expiresAt`。
- producer sequence 对当前 WorkerRun 严格递增；相同 Event ID 的重复由 Inbox no-op，相同或更小 sequence 的新 Event 拒绝。
- Reclaim 更换 WorkerRun/Lease 并重置该 WorkerRun 的 producer sequence；旧 Worker 的迟到事件不能更新 Aggregate。

## 7. Retry、Unknown 与终态

- Executor failure 只形成 Attempt fact；Authority 决定 retry 或 final failure。
- `ScheduleRetry` 只允许从 `Suspended(RetryDecision)` 执行，创建 ordinal + 1 的新 Attempt，并返回 enqueue decision。
- `FailTask` 只允许从 `Suspended(RetryDecision)` 执行。
- `OutcomeUnknown` 进入 Reconciling 并返回 reconcile same run decision；任何 retry command 此时失败。
- Terminal Task 对全部 command/event 都 fail-closed 或幂等 no-op，绝不能回到非终态。
- 取消和完成竞争由先成功原子提交的 terminal event 决定；后到 event 保留在外部审计，但不能改变 Snapshot。

## 8. SchedulerDecision 与 Worker port

第一版 Scheduler decision 闭集：

- `NoAction`
- `EnqueueAttempt`
- `DispatchAttempt`
- `CancelAttempt`
- `AwaitResume`
- `AwaitRetryDecision`
- `ReconcileAttempt`

`WorkerExecutor` 是 RPITIT port，只负责 start/cancel/reconcile 已由 Authority 创建的 Attempt。`WorkerDispatch` 固定 Task/Attempt/WorkerRun、未过期 Lease、idempotency key、WorkspaceKey 和 resolved bindings；cancel/reconcile 使用不同的强类型输入，不能把普通 running 控制对象误用于 unknown reconciliation。Executor 只能返回 provider/local run ref 或有限错误，执行事实通过 Worker event 回流。

本阶段不定义 Provider HTTP、Core Thread、Context Bundle 内容、Policy/Approval 实现或 retry loop。

## 9. Store port 与原子性

`TaskStore` 只定义：

- 创建 version-zero Aggregate。
- 按 Task ID 读取 Aggregate。
- 按 Inbox receipt 读取已提交结果，用于 decision 前快速去重。
- 以 expected aggregate version 原子提交 `TaskCommit`。

`TaskCommit` 固定：

- Inbox receipt（Command ID 或 Worker Event ID）。
- 唯一 committed event 与 expected next stream offset。
- resulting complete Aggregate。
- SchedulerDecision/Outbox records。

Store 必须提供：

1. Inbox receipt 唯一约束，重复输入返回原结果且不重复写 Event/Outbox。
2. expected version CAS。
3. Event offset、Snapshot、Inbox 和 Outbox 同一事务。
4. Outbox 至少一次投递；消费者用稳定 decision/idempotency key 去重。

W1-05 只提供 Port 和 test-only InMemoryFakeStore；SQLite records/transaction 由 W1-06 实现。

## 10. 有界性

- 所有 ID、schema version、idempotency key 有字节硬上限。
- Task bindings、Attempts、proposed events、Outbox records 有 item 硬上限。
- progress 只累计计数/结构化小字段，不保存任意正文。
- 单个领域对象不包含 transcript、tool payload、provider raw response 或 artifact body。

## 11. 非目标

- Workflow/Experts/Automation strategy 或动态策略插件。
- SQL、HTTP、Queue、UI、app-server processor 或 Agent Platform adapter。
- 自动 retry policy、退避和预算计算；第一版只执行 Authority 明确命令。
- Approval/Artifact/Context/Policy 具体模型。
- 普通本地 Thread/Turn 迁移。

## 12. 验收不变量

1. accept/start/progress/suspend/resume/cancel/complete/fail 全链路状态正确。
2. duplicate command/event 不产生重复 Event、Attempt 或 Outbox。
3. worker sequence 乱序、Lease 过期、旧 fencing token、错误 WorkerRun 全部拒绝。
4. Unknown outcome 只能 reconcile 同一 Attempt，不能 retry。
5. Task terminal 状态对所有输入不可回退。
6. Task Authority 在 Contract 中不可变，错误 Authority command 无副作用。
7. Executor API 不存在 create/retry Attempt 能力。
