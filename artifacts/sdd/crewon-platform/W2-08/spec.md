# W2-08 Specification: Provider Control Composition 与 Wave 2 Gate

状态：Discovery 完成，Gate Red；允许进入 A/B/C 独立 Harness，不允许生产切流。

## 1. 目标

W2-08 是 Wave 2 唯一的中心 composition 任务，只把已经通过独立 Gate 的 Provider Connection/Resource、Dynamic Tool、UI Resource layer 和 CloudWorker 组合成默认关闭、可恢复、单一权威的运行路径。它不新增 Provider 领域语义，不切换 Cloud Agent 旧生产链；Cloud Agent 纵向切换仍由 W3-01 完成。

最终需要同时成立：

1. Task outbox 的 Worker 决策由唯一受监督消费者投递给 CloudWorker；成功后才标记 delivered，失败保持可恢复。
2. Provider Run event pump 在进程重启后从 bounded journal page 恢复，不重发 start，不重复 Task transition/outbox。
3. 每次 Provider I/O 都使用当前 State authority 创建 task-scoped client；没有固定进程 owner/client。
4. Single/Assistant chat 的 Provider Tool/Knowledge 调用由 app-server 执行，UI 不持有 Secret、不直接调用旧 PIM executor。
5. UI 只展示真实 Provider/Resource projection，并把 exact binding 引用交给服务端；失败不写 local-only success。
6. 新路径、旧 UI PIM 删除和调用点断言一次完成，不保留 fallback 或双写。

## 2. Discovery 事实与缺口

### 2.1 已就绪

- W2-04：authenticated principal、durable Workspace、Provider Connection/Access Grant/Resource Binding、默认关闭 production factory。
- W2-05：Provider-only Dynamic Tool Router、exact Credential resolver、journal/audit、Provider Tool/Knowledge/Artifact adapter；LocalNode fail-closed。
- W2-06：generated experimental RPC、ProviderResourceSession、断线恢复、picker/composer projection；尚未接入 `App.tsx`。
- W2-07：CloudWorker、secret-free durable authority、task-scoped client、single-page event pump、bounded non-terminal restart query；尚未注册。
- W1 Task State：atomic Snapshot/Event/Inbox/Outbox、pending outbox reopen 与 idempotent delivered 标记。

### 2.2 Provider Run 中心生命周期缺口

- 当前没有生产 Task outbox worker；`DispatchAttempt`、`CancelAttempt`、`ReconcileAttempt` 只存在 durable JSON record。
- pending outbox 查询未按 Worker decision 过滤；若直接读取前 100 条，`EnqueueAttempt`/`Await*` 可能长期遮挡 Worker 项。
- 当前没有失败 defer/backoff CAS；不能用内存 timer 代替 durable `availableAt/deliveryAttempts`。
- Run journal recovery page 已存在，但没有 shutdown-aware supervisor、并发上限或 wake/poll 策略。
- `EnqueueAttempt`、`AwaitResume`、`AwaitRetryDecision` 属于消费者 Authority，不由 Provider worker伪造或自动裁决；W2-08 只投递 WorkerExecutor 能力对应的三类决策。

### 2.3 Dynamic Tool 权威缺口

- Core 发出的 `DynamicToolCallRequest` 到 app-server 时只有 threadId、turnId、callId、namespace、tool、arguments。
- 当前 `bespoke_event_handling` 会把它转成 `item/tool/call` 发给客户端；旧 UI `pimDynamicTools` 再携客户端会话直连 `/api/v1/mcp/tools/*/call` 或 `/api/v1/knowledge/search`。
- Provider Dynamic Tool Router 执行需要 verified `RequestIdentity`、exact Workspace、active Resource Binding、connection/grant/mapping revision；这些事实当前没有与 Thread durable 绑定。
- 仅凭 threadId、cwd、客户端 tag 或当前任意连接推导 actor/workspace 都会造成越权或重启漂移。因此在建立 durable Thread Execution Context 前，禁止 server-side Provider Dynamic Tool dispatch，也禁止先删旧 PIM 后制造假成功。

## 3. 原子阶段

### A. Provider Run Supervisor

新增独立、默认关闭的 supervisor：

- State 提供 bounded Worker-outbox query，只返回 dispatch/cancel/reconcile；limit 1..100。
- 失败 defer 使用 pending row + expected attempts CAS，单调增加 attempts 和 `availableAt`；成功才 delivered。
- 每次 tick 最多处理固定数量 outbox 和 recoverable journal；每个外部调用有 timeout，并发有硬上限。
- dispatch/cancel/reconcile 从当前 Aggregate 重建 typed Worker request，再调用 CloudWorker。
- journal recovery 从当前 Aggregate 重建 dispatch，只在 current lease/attempt 等值时 pump；过期 lease 留给 Authority reclaim，不伪造新 lease。
- shutdown token 停止新工作并等待当前 bounded batch；进程重启由 durable outbox/journal 继续。

### B. Durable Thread Execution Context

建立 app-server/State 的最小 thread authority record：

- threadId、owner actor/tenant/space、WorkspaceKey/scope/scopeId、created/updated revision；不保存 root path、Secret、token 或 prompt。
- exact active Resource Binding refs 独立有序、去重、bounded；每次使用仍回读当前 binding/connection/grant/mapping，不把旧 snapshot 当授权。
- record 只能由 transport-derived `RequestIdentity` + server-resolved WorkspaceRef 创建/更新。
- 首次 authority 必须由同一个 `thread/start` 请求原子建立；禁止仅凭一个已存在的 threadId 事后认领，否则会产生 first-claim 越权竞态。
- 因 threadId 由服务端生成，start/fork 只接受当前会话已注册的 opaque `workspaceKey`；服务端生成 threadId 后创建 Conversation `WorkspaceRef` 与空 binding context，并在响应中返回该 session binding。资源随后通过既有 `resource/bind` 创建，再由 update RPC 写入 exact revisions。
- `thread/resume` 只验证并恢复既有 owner；没有 context 的历史线程仍可普通聊天，但不得启用 Provider 资源。
- `thread/fork` 不继承源线程 authority；请求必须为新线程显式提供 server-resolved Workspace binding/resource bindings，并在返回成功前创建新 context。
- 独立的 binding update RPC 只能更新已经存在且 owner/workspace 相符的 context，不能创建或认领 context。
- archive/unarchive 保留 context；delete 与 thread state 同事务域清理 context；不存在通用 conversation clear API，不为其引入额外生命周期分支。
- dynamic event handler 只能通过 threadId 解析该 durable context；缺失、撤销、漂移一律 fail-closed 并返回用户可理解的工具失败。

### C. Dynamic Tool Server Composition 与 UI 原子切换

- 从 Thread Execution Context + current bindings 构造 bounded `DynamicToolRegistry` 和 Core `DynamicToolSpec`；namespace/tool 必须与 binding-derived registration 完全一致。
- `DynamicToolCallRequest` 命中 Provider namespace 时由 app-server dispatcher 执行并直接向同一 CrewonThread 提交 `DynamicToolResponse`；通用非 Provider dynamic tool 继续走既有 client server-request 协议。
- Provider 路径必须经过 journal/idempotency/audit/timeout/unknown outcome，不能 fallback 到浏览器 HTTP。
- 同一提交删除 UI `executePimDynamicTool`/`isPimDynamicToolCall` 分支和旧 PIM 构造器；保留通用 `PendingDynamicToolRequest` 与非 Provider 客户端动态工具能力。
- `App.tsx` 接入 W2-06 ProviderResourceSession/picker，composer tag 只表达 exact server binding，不把资源正文、Secret 或客户端授权字段塞进 prompt。

### D. Wave 2 Gate

用 hermetic TestAppServer/FakeWebSocket/temporary State/Fake Provider 证明：

- connect/list/read/bind -> thread authority -> dynamic tool dispatch/result；
- Task outbox dispatch -> Provider start -> restart event recovery -> terminal Task；
- disconnect/reconnect、app-server restart、cursor duplicate/gap、timeout、credential/grant/mapping/resource revoke；
- UI 不直连 Provider，旧 PIM API 调用点为零，新路径没有 one-shot chat fallback；
- shutdown 不接受新 batch，未完成项重启后继续且不重复副作用。

## 4. 安全与正确性不变量

1. Thread/Task authority 均来自服务端持久事实，不能从 UI、模型参数、cwd 或当前任意连接猜测。
2. 新 Thread 的首次 owner 绑定必须发生在 start/fork 生命周期内；独立更新 API 永远不能创建 owner authority。
3. Provider Run 与 Dynamic Tool 每次 I/O 前重验 active connection/grant/mapping/resource revision。
4. Secret、token、private key、raw Provider payload 不进入 Task/Thread/Artifact/Audit 非敏感表、UI 或日志。
5. 所有 list/page/body/argument/result/concurrency/retry 都有硬上限。
6. outbox 是 at-least-once；Provider command + journal/inbox 共同保证幂等。成功前不标记 delivered。
7. supervisor 不创建 Attempt、不决定 retry、不伪造 lease；Authority 决策仍来自消费者状态机。
8. Provider dynamic tool 失败不回退浏览器 PIM；非 Provider 通用 client dynamic tool 不被误删。
9. 默认关闭配置缺失时不启动 supervisor、不注册 Provider dynamic tool、不恢复旧 authority。

## 5. 非目标

- 不在 W2-08 创建 Cloud Agent 产品 Task、Office Task 或 Workflow DAG。
- 不切换/删除旧 Cloud Agent chat/session；W3-01 负责。
- 不实现 LocalSnapshot/LocalFork materialization、Provider approval/tool-result 或 Secure Local Bridge。
- 不引入通用 DI 容器、第二数据库、分布式队列或多进程 leader election。
- 不把消费者 Authority 的 enqueue/retry/resume policy塞入 Provider supervisor。

## 6. 停止条件

- Thread 没有 durable verified principal/workspace/resource context 时，停止 Dynamic Tool cutover。
- State 没有 durable backoff/CAS 或 Worker decision filter 时，停止 supervisor production registration。
- 任一 restart、revoke、cursor、idempotency、shutdown 或旧调用点扫描失败时，Wave 2 Gate 保持 Red。
- 真实部署 key/model smoke 未通过时，可完成默认关闭 composition，但不得由 W3-01 切生产流量。
