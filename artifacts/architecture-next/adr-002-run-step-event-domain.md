# ADR-002：统一 Run、Step、Attempt 和 Event 领域模型

状态：Accepted  
日期：2026-08-08

## 背景

当前 Single、Office、Automation、Agent Platform 和正在建设的 Workflow 各自拥有部分状态、恢复和展示逻辑。Office 尤其同时涉及 Thread、成员委派、Scheduler、Verification、Memory、Artifact 和文件账本。

如果重构只更换语言而不统一执行模型，新的 TypeScript 控制面会再次出现多套状态机。

## 决策

1. `Run` 表示一次不可变目标、Authority、执行策略和版本快照。
2. `Step` 表示模型、Tool、Agent、Workflow Node、Verification 或 Human Gate 的逻辑步骤。
3. `Attempt` 表示 Step 的一次执行尝试；retry 必须创建新 Attempt。
4. `RunEvent` 是 Authority 分配 sequence 的有界执行事实。
5. Snapshot 由 Event Reducer 生成，但完整 Transcript 和 Payload 不进入 Event 表。
6. Single、Workflow、Office、Experts 和 Automation 共用该模型。
7. Office 只拥有团队定义和 UI projection，不拥有独立 Scheduler、Reducer 或 Run Store。

## 领域关系

```text
Thread 1 --- n Run
Run 1 --- n Step
Step 1 --- n Attempt
Run 1 --- n RunEvent
Run 1 --- n Approval
Run 1 --- n ArtifactRef

OfficeDefinition -> AgentVersion[] + WorkflowVersion + ProjectionPolicy
Automation -> schedule + RunTemplate
```

## 事件规则

- `sequence` 只由 Run Authority 分配并单调递增。
- Event ID 全局唯一，但客户端排序只依赖 `runId + sequence`。
- Event 包含 bounded metadata 和 payload ref，不包含无限 Tool stdout、模型全文或文件内容。
- terminal Event、Snapshot、Inbox receipt 和 Outbox 同事务提交。
- stale lease/epoch 结果可以形成 audit event，但不能更新 canonical Snapshot。
- 用户可见进度只能由真实 Event/Step 状态投影。

## 拒绝方案

### 保留 Office 专用状态机

拒绝。它会继续复制 retry、approval、artifact、recovery 和 verification 语义。

### 所有业务都采用完整 Event Sourcing

拒绝。Agent/Workflow execution 需要追加事件，AgentVersion、WorkflowVersion、Resource 和用户设置不需要为了统一形式而全部 event sourced。

### 用 Thread Rollout 兼任调度事件

拒绝。Transcript 历史与 durable scheduling 的查询、保留、敏感性和事务需求不同。

## 后果

- Office/Workflow UI 需要从统一 Snapshot/Event 构建 projection。
- 旧 Office JSON 必须一次性导入或只读归档。
- API 和 Worker 对 Run revision、Step state 和 Attempt retry 需要严格区分。

## 验收 Gate

- reducer 对相同 Event 序列 deterministic。
- duplicate、out-of-order、stale epoch 和 terminal-after-terminal 测试通过。
- Human Gate 挂起不占 Worker。
- Office PoC 不新增 Office 专用 retry/scheduler table。

## 2026-08-09 实施进度

`packages/domain` 已落地通用 Step kind、Step/Attempt 状态和纯 transition：首次 Attempt、retryOf、running Attempt
abandon、retryable failure 回到 ready、completed/canceled/failed terminal，以及 stale terminal write 拒绝。SQLite v15、
PostgreSQL 与 InMemory Store 已实现 `run_steps`/`run_attempts` authority；Worker 每个 lease 创建独立 Attempt，retry 与 Work Item
release 原子提交，success/failure/cancel 与 Run terminal 和 Work Item settlement 原子提交。真实 SQLite/PostgreSQL
`SIGKILL` 测试证明旧 running Attempt→abandoned、新 Attempt 的 `retryOfAttemptId` 和最终 completed 均跨进程持久。

Model/Tool Step、per-action Approval 与 Standalone Tool-output Artifact projection 已进入真实 Worker/Control API 纵向链路；
Agent、Workflow Node、Gate 与 Verification 的多 Step scheduler，以及 Team Artifact/KMS/scan/streaming 尚未完成，不得把本段
外推为全部 Step kind 或多节点 Artifact 已具有生产执行等价性。
