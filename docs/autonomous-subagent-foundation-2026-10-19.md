# 自主子 agent 基础边界（2026-10-19）

这份记录把当前 CrewON 的可复用执行基础、与 ChatGPT 逆向结果的对应关系，以及接入自主子 agent 前必须补齐的持久边界固定下来。本阶段只确定契约和迁移顺序，不启用自主递归执行，也不改变现有 HTTP、事件或数据库形状。

## 当前证据

### 可以复用的基础

- 普通 Run 已有有序事件、终态、取消请求、工具回执、租约和未知副作用恢复。Run 的 `purpose`、冻结的 runtime/policy/workspace 绑定和工具权限可以作为子执行的继承上限。
- Workflow 已有固定版本、DAG 节点 claim、lease/CAS、`workflow_node_children` 和父取消传播。它适合“部署后固定的工作流节点”，不是通用的模型动态 spawn 协议。
- Team journal 已有原子 admission、fenced command/observation effect、lease 接管、跨进程 SIGKILL claim recovery、未知 effect 单次回执和 durable cancellation signal。
- 当前 durable Team 的 HTTP admission、snapshot、cancel 和 Run SSE 回流已在 standalone SQLite 上通过真实链路验证；默认 feature gate 仍关闭，生产 Host identity 尚未接入。
- 上下文和持久 JSON 已有多处有界校验；模型可见 fragment 必须保持增量、有界，单个注入片段不能超过 10K tokens。

### 当前缺口

`TeamTaskIntent` 只记录一个 Team task 的固定 plan、主 Thread 和执行身份。`TeamTaskEffect` 中虽然会记录 `forkThread`、`createRun` 等调用，但这些只是效果请求和回执：

- 没有一等的 `parentTaskId`、`rootTaskId`、`depth` 或 child ordinal；
- 没有可授权读取的 parent/child 索引，无法在恢复、取消和结果回流时可靠枚举后代；
- 没有子任务级 deadline、数量、深度、token 或输出预算；
- 没有把“父任务等待子任务”建模为可释放执行槽的持久状态；
- 当前 Team Host 仍要求显式注入 Actor、AuthorizationPort/operations 和 digester，Production Worker 尚未拥有可审查的后台 service identity；
- 因此不能把 renderer 中现有 Team coordinator、Workflow 的固定 child 表，或 journal effect JSON 直接宣布为通用 subagent scheduler。

## 与逆向 ChatGPT 的可借鉴边界

本机 ChatGPT 逆向材料确认了几个方向：执行有明确 owner，子任务有 descendant/interrupt 语义，宿主负责队列和工具派发，流式结果由单一有序消费者收敛。它没有提供云端完整数据库、真实并发参数或完整 subagent 算法，不能据此复制私有协议、Rust/Swift host 或固定调度常量。

CrewON 应借鉴责任分层，而不是实现细节：

| 目标     | 应复用/建立的 CrewON 边界                                      | 不应做的简化                          |
| -------- | -------------------------------------------------------------- | ------------------------------------- |
| 父子关系 | 持久、可查询、带 tenant/space/actor 校验的 task edge           | 不把 effect JSON 当关系索引           |
| 预算     | admission 时冻结的 depth/children/deadline/token/output 上限   | 不只在 renderer 里计数                |
| 执行     | 复用现有 Run/Worker/Tool lease 和 receipt                      | 不另起 subagent runtime               |
| 等待     | 父任务进入等待状态并让出容量，child 终态再唤醒父任务           | 不让一个 Worker lane 长时间同步等待   |
| 取消     | durable root cancel 向后代传播；未知外部副作用仍走 reconcile   | 不把 AbortSignal 当成外部回滚证明     |
| 回流     | 结果只回传 bounded summary、digest、引用和状态                 | 不把所有 child 原文拼回父上下文       |
| 权限     | child 能力是 parent 的上限，跨 tenant/space/actor 必须显式授权 | 不继承浏览器 session 或固定测试 actor |

## 拟定的最小契约

第一版应是一个独立的内部 domain/application 契约，先在 standalone SQLite 验证，再决定公开 HTTP 版本。字段语义如下：

```text
TaskLineage
  rootTaskId
  parentTaskId | null
  depth
  childOrdinal

TaskBudget
  maxDepth
  maxChildren
  deadlineAt
  tokenBudget | null
  outputBytesBudget

TaskCapabilitySnapshot
  tenantId
  spaceId
  actorId
  principalId
  authorityId
  runtimeGeneration
  policySnapshotId
  workspaceBindingId | null
  toolPermissionMode
```

约束：

1. `rootTaskId`、`parentTaskId` 和 `childOrdinal` 必须在一次原子 child admission 中确定；同一 parent 的 ordinal 不能重复。
2. child 必须继承 tenant、space、authority、runtime、policy 和 workspace 上限；能力收窄只能由明确的授权策略决定。
3. `depth`、child 数量、deadline 和输出/Token 预算在 admission 时检查，并在持久记录中冻结；不能由模型输出自行扩大。
4. parent 的 spawn effect、child task record 和必要的 wake item 必须使用同一持久事务或等价的 fenced receipt；重试只能 replay，不能生成第二个 child。
5. parent 等待 child 时，parent scheduler claim 必须结束或进入可恢复 waiting 状态；child 终态通过持久 wake 唤醒 parent，不占用一个长期执行槽。
6. root cancel 必须可枚举并标记后代；每个正在运行的 child 仍需自己的 lease、终态和未知 effect recovery。
7. parent 只接收有界结果摘要、状态、digest 和 artifact/run 引用。原始 child 输出继续留在 child Thread/Run 的权限范围内。

## 不直接复用现有两套关系的原因

- Workflow child relation 绑定冻结的 WorkflowVersion、node claim 和 DAG 依赖；把动态模型 spawn 塞入它会让“固定部署图”和“运行时递归任务”共享错误的恢复和授权语义。
- Team effect journal 适合记录一次 command/observation 的未知结果；它没有 child 查询索引和独立生命周期。只在 JSON 里增加 `parentTaskId` 会让取消、预算和恢复继续依赖扫描所有 effect，无法形成明确的一等约束。
- RunState 当前没有通用 `parentRunId`。直接添加字段会影响事件、快照、SQLite/PostgreSQL 读写和兼容迁移，应在确定 task edge 所有者后再做，而不是先改 Run shape。

## 实施顺序

1. **先做纯校验和值对象**：增加不可变 lineage、budget、capability snapshot 的 capture/validate，覆盖深度、数量、deadline、token/output 上限和跨 scope 拒绝；不接 HTTP、不启用 spawn。
2. **再做持久 task-edge 表/存储接口**：SQLite 与 PostgreSQL 都提供按 root、parent、child 的有界查询，带 actor/tenant/space 授权；迁移必须可回滚，旧 Team task 视为空 lineage。
3. **实现原子 child admission**：parent effect、child task、wake item 和 idempotency receipt 一起提交；先只允许显式受信 Host 调用，禁止模型直接发起任意 child。
4. **接入 scheduler waiting/resume**：验证父任务释放 lane、child 并行上限、重启恢复、重复 wake 和 owner lease takeover。
5. **接入取消和结果回流**：补 root cancel、后代枚举、bounded result projection、SSE/快照恢复和审计查询。
6. **最后开放自主触发**：先 standalone/canary，再生产 service identity；默认关闭递归，逐步开放深度和数量策略。

每一步都要有 SQLite 真实链路、PostgreSQL（有测试库时）、重启/强杀、取消、幂等冲突和权限越界测试。没有这些证据前，不把“Team 已能后台运行”表述成“自主子 agent 已完成”。

## 当前决定

本记录之后的下一项代码工作是第 1 步的纯值对象与校验测试。它不会改变已有 Team task 的 schema、HTTP contract、默认 feature gate 或生产启动路径；如果验证发现现有预算/权限类型无法无歧义复用，再先停在设计层，不为兼容性强行扩展 Run 或 TeamTaskIntent。
