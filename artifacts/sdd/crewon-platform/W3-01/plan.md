# W3-01 Implementation Plan

## Stage D0: Discovery 与 Gate（已完成）

1. [x] 盘点旧 protocol/processor/local session/UI Promise/fake Turn/thread source 全链路。
2. [x] 确认 Durable Cloud Agent 使用 `StrategyKind::Single`，不新增 Strategy。
3. [x] 确认标准 Thread/Turn API 是唯一 UI contract，不新增 `cloudAgent/*` 或公开 Task mutation API。
4. [x] 识别 execution binding、Provider event payload、output Artifact read/import、Turn projection 和 retry Authority 五个前置缺口。
5. [x] 冻结 default-off、无 fallback、binary rollback fence 与旧链原子删除原则。

## Stage A: Result Durability 与 Provider Adapter

1. [x] Harness Red：同 metadata/different completed output refs 必须 conflict；typed projection 严格、bounded、canonical、task-bound 且 Debug redacted。
2. [x] State `0049_provider_run_event_projection.sql` 保存 canonical bounded Provider event projection，并让 journal advance 与 projection 原子提交；legacy binary 仅允许 `NULL/NULL` compatibility pair，partial pair 被数据库拒绝。
3. [x] Provider event digest/Worker idempotency identity 纳入 canonical payload；既有 metadata-only 记录不会被新 binary 当成相同事件静默接受。
4. [x] 新增 bounded event projection read/recovery API，供后续 projector 在 restart 后按连续 sequence 重读 exact progress/failure/output refs；legacy metadata-only、gap、越界 sequence 与 hash/digest drift 全部 fail-closed。
5. [x] 新增 `ProviderRunArtifactClient`：context Artifact idempotent import + result `./artifacts:read`，验证 exact authority、headers/body/media/digest/UTF-8/64 KiB/time bound；unknown outcome不在 adapter 内语义重试。
6. [x] 新增 Run output Artifact importer，复用 Artifact/Audit adapter；Artifact creation绑定 Task/Run/Attempt，metadata-only association Audit绑定 Thread/Turn，两者绑定同一 exact Agent/Trace，body 不进入 Debug/error/audit。
7. [x] CloudWorker 对 approvalRequired进入ApprovalRequired suspended stop，对toolResultRequired和无本地提交authority的toolResultAccepted进入ProviderPaused suspended stop；exact事件与cursor先持久化，supervision不再调度suspended run，不做无限poll/backoff。

## Stage B: Cloud Agent Thread Authority

1. [x] Harness：execution binding 不是 Agent、不在 resource set、revision drift、revoke、cross-owner和已有 Core Turn全部拒绝；exact ProviderManaged/Provider Agent才可选择。
2. [x] `0050_thread_execution_binding.sql` 为 Thread Execution Context 增加 optional exact execution binding；canonical hash、State/runtime/protocol/schema 同步，`None` 保持 v1 hash domain兼容。
3. [x] 既有 `thread/start`/fork/update/resume/delete Thread Execution Context lifecycle 接入 execution binding projection、owner/workspace guards和 rollback；Cloud Agent专属 fork/steer/interrupt语义仍按 D-07/D-06实现。
4. [x] UI Agent picker 用 Provider Resource Binding 建立 execution target；Provider Agent不进入 `+` 资源标签，`provider-agent:*` 不产生 legacy `agentPlatformAgentId` authority。
5. [x] 明确 Cloud Agent Thread 与 Core local Turn 互斥；已有 Core Turn 的 Thread 不允许就地改成 Cloud Agent，带 execution binding 的 Thread不允许误走本地 Core route。
6. [x] 首个 durable Cloud Task创建后 execution binding immutable；由 Stage C 同事务 CloudAgentTurn/Task mapping与数据库外键提供事实，不以 Core history或UI状态推断。

## Stage C: Turn -> Task 原子协调层

1. [x] 新建窄模块 `cloud_agent_turn`，协调、Artifact materialization、State authority revalidation分别位于私有模块，不向 `crewon-core` 添加业务概念。
2. [x] Harness：重复 clientUserMessageId、同 Thread 并发 start、late transaction failure、restart durability、changed replay与revoke race。
3. [x] 用既有 Governed Context 校验 bounded Single conversation fragments，并持久化 immutable prompt/context Artifacts。
4. [x] `0051_cloud_agent_turns.sql` + State 单事务提交 queued Task + accepted event/outbox + CloudExecutionSpec + CloudAgentTurn mapping；事务内再次重验 exact connection/grant/identity。
5. [x] `turn/start` 在 execution binding 为 Agent 时调用 coordinator；无 binding 继续原 Core path，任何 Cloud 失败不 fallback；consumer flag默认关闭且依赖Provider Control Gate。
6. [x] 第一阶段只接受一个非空 plain text input，非文本、资源标签和所有 per-turn override 返回稳定 capability error；不改主页 composer 无关交互。
7. [x] Cloud Agent Single consumer Authority消费`EnqueueAttempt`并创建一次fenced Claim；消费`AwaitRetryDecision`把known failure/cancelled确定性`FailTask`；unknown outcome保持reconcile，不自动重试；其他Strategy/consumer不进入该查询。

## Stage D: Projector、标准会话与恢复

1. [x] Harness：progress/finalize/restart/cursor duplicate/gap 与 Artifact import commit 后故障恢复。
2. [x] terminal notification只传metadata并在每个连接上以fresh identity重验exact owner/revision；通知丢失时由durable read/resume恢复，不依赖内存Promise。
3. [x] cancel authority、credential revoke与可见状态收口Harness完成：queued/running cancel均先以Task terminal事实决定胜者；queued cancel不依赖Provider journal即可投影标准cancelled Turn；known failure等待Single Authority；unknown/gap保留同一Run并停止推进，不伪造terminal；revoke在下一次受保护I/O fail-closed。
4. [x] bounded `CloudAgentTurnProjector` 按 task/run contiguous sequence 投影 progress/failure/completed，projection cursor durable。
5. [x] completed 先读取并导入 verified output Artifact，再原子把 Turn 置为 completed；中间状态为 durable finalizing，non-retryable failure 终结为 resultUnavailable。
6. [x] 用 deterministic turn/item IDs 发送标准 `turn/started`、item/turn complete 和 status notification；progress 不生成系统气泡。
7. [x] `thread/read`/`thread/turns/list`/resume initial page 从 CloudAgentTurn + verified local Artifact 返回标准 Turn/Item；断线不依赖内存 Promise。
8. [x] thread list/search/sidebar summary 与 ThreadStore metadata幂等同步，restart 后可补偿。
9. [x] `turn/interrupt` 映射 stable `CancelTask`；重复/并发/restart cancel幂等，terminal race不创建第二语义取消，非 Cloud Agent与空turnId startup interrupt继续原 Core path；旧enqueue/dispatch被终态取代时无外部副作用地确认，当前cancelAttempt仍durable交付。
10. [x] steer/inject/compact/fork在Cloud execution binding下明确capability unsupported；guard位于既有Thread解析之后，Core参数校验、Core执行路径与错误优先级保持兼容。
11. [ ] 第一切片隐藏delete/archive/unarchive并由backend fail-closed；未来启用这些操作前，必须实现State-only lifecycle、projection cleanup与Artifact retention原子边界。

## Stage E: Legacy Import 与 UI 原子切换

1. [x] 实现 bounded、symlink-safe、digest-journaled legacy session importer；只导入历史，不继续读取/写入旧文件。
2. [x] 实现 rollback fence compatibility：识别保留 source `crewon_cloud_agent_provider_binding_v1`，拒绝内容、执行、binding、delete及archive/unarchive mutation，且该版本不能创建此 source。
3. [x] 单独构建并验证 fence binary artifact；SHA-256 `3c4d3028d8a8aebc072baa3b4d9e7adac4b82765b70ebe4a4a434b84e5d71cc9`完成隔离WebSocket部署与二次重启rollback演练，只有该artifact可成为后续cutover rollback target。
4. [x] UI 删除 Agent Platform send/history/cancel special branches，标准 Thread actions 成为唯一链路；首次 Provider Agent 选择强制创建 exact binding Thread，旧 raw route先fail-closed并已在E-05完整删除。
5. [x] 删除 app-server old chat/session/cancel RPC、notifications、processor、stream/in-memory run/local write path 和 generated schema。
6. [x] 删除 `agentPlatformAgentId` execution authority 与 `agent-platform:agents:` production route；保留明确列出的 resource-management能力。
7. [x] 更新 UI snapshots：统一主页会话/输入框风格，无执行系统气泡，云 Agent final result 为标准 agent message。
8. [x] 加入 callpoint/dependency scan：old RPC、old session write、one-shot chat、Run Promise、fake Turn、failure fallback 全部为零。

## Stage F: Gate、Live Smoke 与发布

1. [x] 完全 hermetic E2E：真实WebSocket app-server + temporary State + RS256 identity/Provider authority + Fake Provider覆盖success/progress/disconnect、duplicate start、app-server restart、Provider暂时不可用后同Run恢复与标准Thread结果；标准`turn/interrupt`重复取消只产生一次Provider cancel。duplicate event、unauthorized/revoke、cursor gap、known failure、unknown outcome和Artifact corruption由同一fake Provider/temporary State测试金字塔的严格adapter/Worker/projector Harness覆盖。
2. [ ] scoped protocol/state/provider/app-server/core/UI tests、snapshots/lint/build、Bazel lock、breaking-change/security/size review。
3. [ ] 经用户授权先完成 Wave 2 full workspace `just test`；Green 后才允许 W3-01 production cutover。
4. [ ] 使用测试 Provider key/model 做 live smoke：start 后分别重启 app-server/Provider，验证同 Run 续读、final Artifact 和 thread/read唯一结果。2026-07-25 前置审计确认当前 8000 是真实 Agent Platform backend，但 `/provider/v3`、`/identity/v1` 均未挂载；本地库没有 active AgentVersion、verified personal model key 或 active NewAPI binding，因此不得把当前环境误报为可执行 live fixture。
5. [ ] 最终 release bundle 默认关闭或按部署计划显式启用两个开关；同版本中旧执行链已删除，不存在 fallback。
6. [ ] 只向已验证 fence 版本演练 binary/container rollback，记录 new-thread read-only、schema forward-only 和重新前滚恢复步骤。
7. [ ] scoped `just fix -p` 后最后 `just fmt`；按仓库规则不在 fix/fmt 后重跑测试。

## Review staging 与并行边界

| Review slice | 内容 | 可并行条件 |
| --- | --- | --- |
| A1 | Provider event projection + State migration | 独立进行 |
| A2 | Run Artifact typed client + importer | 可与 A1 并行，冻结 record contract |
| B1 | Thread execution binding State/protocol | 可与 A 并行 |
| C1 | prompt/context builder | B1 type 冻结后可独立 |
| C2 | atomic Turn/Task/Spec mapping | A1/B1 contract Green 后 |
| D1 | projector/read/cancel | C2 + A2 Green 后 |
| D-06 | stable cancel coordinator与标准interrupt窄路由 | D1 read/projector事实已稳定；不依赖D-07 capability/完整terminal收口 |
| E1 | legacy importer | CloudAgentTurn record 冻结后可与 D1 并行 |
| E2 | UI cutover/deletion | D1 E2E Green 后，不提前删除 |
| F | full Gate/live/cutover | 所有前置 Green 且获得必要授权 |

复杂生产切片目标小于 500 行；任何非机械 diff 超过 800 行必须拆分。中心 request processor 只新增窄调用点，领域/持久化/投影逻辑放入新模块和独立测试文件。
