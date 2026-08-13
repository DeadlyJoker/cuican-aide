# WS1 实施状态

日期：2026-08-13
状态：In progress

本文件记录当前 source tree 已验证的事实，不把局部测试外推为 WS1 或完整迁移完成。

## 2026-08-13 执行方向覆盖：纯 TypeScript 快速切换

以下规则覆盖本文后续较早的 Rust parity、Device/Gateway、legacy App Server 和多轨兼容计划：

- Agent Runtime、Workflow、Workspace、Control 和持久化生产 authority 只继续落在 TypeScript；不再实现 Rust Runtime/App
  Server 兼容、回退、双写、行为对齐或共享 fixture 扩展。Rust 只保留 Tauri 桌面壳与
  `crewon-process-guardian`。历史 Rust/Device/Gateway foundation 不再是迁移完成条件，也不得重新接入 production composition。
- packaged bundle 当前只有 guardian、Node 与 Control API、Provider coordinator、Runtime Release、Runtime Worker 四个 TS
  bundle；不包含或启动 Rust Device、Rust App Server 或 Gateway sidecar。
- W01 production transaction protocol、Workflow Start、scheduler fan-out、node admission、node settlement、Human Gate、
  reconciliation、terminal convergence、真实 PostgreSQL 双连接和 packaged crash recovery 均已有纵向证据，状态为通过。
  这不代表整个产品迁移完成。
- Renderer 已改为 Control-only bootstrap。Library 与 Settings 不再构造 App Server client：Library 的 Automation/Knowledge/
  Agent/Office/Tool 读取和允许的 mutation 走 Control；Settings 只公开 Account、Appearance、Model access 三个具有真实 Control
  authority 的页面。语言/主题使用 revision CAS，成功提交后才更新本地状态；旧 Config、Personalization、Thread Settings 和
  Library Office/Agent coordinator 已从 production composition 及源码删除。
- 2026-08-13 当前 UI 证据：Node 24 TypeScript lint 通过；完整 Vitest `281/281` files、`1799/1799` tests；production build
  通过。签名、notarization、updater 凭据和 Windows 实包仍是外部发布边界。

本文下方涉及“下一步接 Rust Device/Gateway/Native dispatcher”或“Rust compatibility 未完成”的段落只保留为历史记录，
不再驱动当前迁移。

## 已落地

### 2026-08-12 Native raw Tool receipt foundation（production route 未开放）

- 新增了独立 raw Tool dispatcher/journal foundation，但 production `crewon-device-runtime` 尚未把它接入 WSS frame route、
  Hello capability advertisement 或 reconnect replay。现有 `workspace.read_file.v0` 继续走 dedicated Workspace Read
  dispatcher，以及 `crewon.device-filesystem-read-event.v0` / `crewon.device-filesystem-read-ack.v0`；Gateway 仍能用
  connection epoch、workspace binding/incarnation 和 command digest 做 durable commit-before-ACK correlation。
- Native Tool admission 在 accepted receipt 前严格完成 bounded wire parse、Ed25519、Device identity、显式
  capability registry、`workspace.read_file.v0` 参数 schema（workspace incarnation、canonical path segments、encoding）、
  limits、stable-handle metadata 和 current connection epoch 检查。accepted durable 后、primitive 调用前再次获取
  current-epoch permit；takeover 会落 `execution.unknown_outcome`，不会提交旧 epoch completion。
- SQLite device journal v4 新增独立 Tool command/event/ACK authority foundation。新命令先事务持久化
  `execution.accepted`，terminal 持久化后才允许 cumulative ACK；exact duplicate 返回 accepted-in-flight 或 terminal replay，
  changed binding/action digest fail closed。进程重启发现 accepted-only 时只持久化并重放 unknown outcome，绝不重新执行
  primitive；该 authority 当前没有接入 production WSS Hello 或 reconnect projection。
- foundation dispatcher 的生命周期已对齐 dedicated read 模板：journal write transaction 内只做 bounded command/auth/binding
  metadata admission 与 single-flight reserve；accepted commit 后才在 current-epoch permit 下获取 stable handle并立即释放 permit，
  blocking read 在 permit 外执行，成功后再做 post-read epoch fence。handle acquisition/fence failure 落 unknown outcome，primitive
  read error 落 failed。确定性 barrier 覆盖 acquire 不发生在 accepted transaction 内、阻塞 read 时高 epoch takeover 能完成、旧结果
  只能落 unknown 而不能落 completed。
- foundation 的显式 executor 验证表明 `workspace.read_file.v0` 专用 wire schema能够无损绑定 path、limits 和 action digest，
  但 production capability registry 尚未 advertise raw Tool primitive。没有 advertise shell/process mutation，也没有用
  capability/name string convention 偷渡参数。
  shared TS/Rust `device-protocol.reference.json` 继续作为 command/signature/filesystem-read wire fixture；新增 dedicated
  `tool_journal_tests.rs` 与 `native_tool_dispatcher_tests.rs` 覆盖 takeover、duplicate/replay、changed digest/binding、
  terminal-before-ACK 和 accepted-only restart。packaged Workspace Read 的 production wire 继续由 dedicated WSS 回归覆盖。
- 阻断回归使用同一 shared fixture 穿过完整 `DeviceGatewaySession.executeWorkspaceRead` WebSocket multiplexing，验证 dedicated
  command 被实际发送、accepted/terminal 在 store commit 后才分别产生 ACK，且 Native mTLS WSS runtime 仍发送/接收相同的
  filesystem-read command/event/ACK family。focused evidence：Gateway session + Workspace Read session `12/12`、Gateway
  typecheck、device-journal `24/24`、device `32/32`、device-runtime `21/21`。
- 仍未开放：shell/process execution、任意 payload/artifact mutation primitive、UDS transport、HSM/KMS、跨机器长断线授权续期，
  以及能对外部有副作用 Tool 做 authoritative reconcile/cancel 的 provider receipt authority。新增有副作用 capability 前必须
  注入显式 executor/reconciler，并证明 durable provider terminal identity；不能沿用 accepted-only -> retry。

### 2026-08-09 append-only Thread rollback Control cutover

- `thread.rollback` 现在由独立 Application/Store Port 持有，不再把“回退”实现成删除或重写 Message/Model History。命令使用
  `thread:rollback` 授权、Thread revision CAS、CSRF、Idempotency-Key 和 receipt-first replay；同 key 的未知提交结果只重试
  原始冻结请求，409 会重新读取权威 Thread 后显式返回冲突。
- canonical authority 是 `thread.rolled_back` Thread event、append-only Model History rollback marker 和事务内维护的
  Message invalidation read model。标准视图先过滤 invalidated Message 再分页，audit 视图保留原物理账本与失效关联；Thread 的
  `lastMessageSequence` 不被倒写。InMemory、SQLite v19 和 PostgreSQL Thread authority v5 在同一事务内校验 Thread/history
  fence、无 nonterminal Run、无未结 WorkItem，追加 event/marker、失效 Message、删除旧 provider continuation/model state 并写
  durable receipt。receipt replay 会深验全部失效效果，不能用一个结构正确但遗漏部分 tombstone 的回执冒充成功。
- 回退只改变标准 transcript/model context，不撤销 Goal、已经完成的 Tool/File/Workspace 外部副作用或 terminal Run；Plan 随其
  Message 从标准 transcript 隐藏，但审计账本保留。存在运行中 Run 或未结 WorkItem 时命令返回冲突，不会一边执行副作用一边改变
  历史边界。当前 UI 操作固定回退最近一个 instruction turn；HTTP/Application contract 已支持 bounded `numTurns` 和 overshoot。
- fork 读取 audit Message ledger 与 raw Model History，再通过同一 effective-history projector 复制 surviving history，重新连续编号并
  重映射 surviving compaction boundary；被回退的 Message 不会进入新 Thread。context projection、manual/auto/model-switch
  compaction 也先投影 effective history；retained users 只接受真实 `source=thread_message` 的 user turn 与 surviving compaction
  retention，明确排除 Goal continuation/steering，关闭“回退后再次压缩导致内容复活”的 P0。
- Control API 已提供严格 `POST /api/v1/threads/{threadId}:rollback` 与 redacted `thread.rolled_back` SSE；公开 response/event 不包含
  tenant、actor、marker ID、raw history 边界或失效 Message。typed client、`ControlThreadRuntime` 和 settings action 已接入同一
  Control authority；成功或远端 rollback SSE 会终止该 Thread 的旧 Run stream、清理 streaming/active-turn UI 并从 standard view
  重新读取。Control 已配置但不可用时显式 fail closed，不会回退到 legacy Rust RPC。
- Rust/TS 共享 fixture 冻结 ordinary/cumulative/contextual/compaction 边界；TS 目前没有结构化 inter-agent history source，因此该
  场景明确标为 unsupported，而不是猜测边界。验证证据：Domain `67/67`、Context `16/16`、Application `62/62`、Runtime Worker
  `109 pass/1 PostgreSQL-unconfigured skip`、Contracts `37/37`、Control client `38/38`、真实 PostgreSQL 15 Control API
  `49/49`、UI focused `32/32` 与 production build；真实 PostgreSQL 15 Store 全量 `294/294`。Rust focused shared fixture
  `1/1`，未把它外推为 Rust workspace 全量通过。

### 2026-08-09 manual context compaction Control cutover

- `POST /api/v1/threads/{threadId}:compact` 使用 CSRF、Idempotency-Key、Thread revision CAS 与可选 immutable
  AgentVersion；receipt replay 发生在 route resolution 前，未知结果重试不会因 catalog 暂时不可用而失去原回执。
- 命令以 `purpose=manualCompaction` 创建独立 maintenance Run，不追加 user/assistant Message。Store 在同一事务/Thread lock
  下验证 history head、无 nonterminal Run、Goal 非 active，并原子写 Run/Event/Outbox/WorkItem/receipt；空历史明确返回
  `context_compaction_not_applicable`，不会让模型总结只有系统提示的空会话。
- Worker 使用原有 bounded compactor 和 lease-fenced Step/Attempt，但 manual 成功事务一次提交 compaction ModelHistory item、
  `context.compacted(mode=manual)`、`run.completed(outputRef=null)`、Attempt completion、Outbox 和 WorkItem settlement；terminal
  receipt 在 WorkItem 已 settled 后仍可重放。失败/取消不安装半个 compaction authority。
- active Goal 暂时作为显式 admission gate；maintenance Run 期间 Goal mutation fail closed。后续若开放 active Goal，需要先把
  compactor usage 与 Goal accounting cursor/Goal CAS 放入同一事务，不能静默使用 unbound Run。
- Renderer 的 settings action 在 Control authority 下只调用 typed Control runtime；maintenance Run 从 user Message/Run 索引
  关联中排除，避免生成空白或错配 Turn。legacy memory 尚未切换，不会通过 Control fallback 冒充支持。
- 验证证据：Contracts `37/37`、Application `49/49`、Control client `27/27`、Runtime Worker `106 pass/1 PG-unconfigured skip`；
  manual compaction InMemory/SQLite/真实 PostgreSQL 15 纵向 `3/3`，真实 PostgreSQL Store `271/271`、Control API `45/45`。
  UI focused `32/32`。临时 PostgreSQL 容器在验证后已删除。

- `packages/contracts`：
  - Run status/contract、Thread/Message wire contract、bounded canonical Agent Event v0。
  - OpenAPI 3.1.1 Thread/Message/Run REST/Error/SSE source，严格 request parser、opaque Message cursor 和 generated
    TypeScript types drift Gate。
  - Thread Goal PUT/DELETE 与独立 Goal event SSE contract；`Last-Event-ID` 使用 Thread 范围 durable event sequence，
    不复用可能在 clear 后重置的 Goal revision。
- `packages/domain`：
  - 带 tenant、space、creator 和固定 route identity 的 Run reducer；cancel、approval、suspend、reconcile 和 terminal 约束。
  - Thread reducer、active/archive 状态、连续 Thread Event/Message sequence，以及 Message role/content digest 约束。
  - bounded text execution Event：segment start/completion/failure、model delta、usage、assistant Message completion。
  - 通用 RunStep kind 与 Step/Attempt 状态机；Attempt retry 保留 `retryOfAttemptId`，新 lease epoch 会将旧 running
    Attempt 标为 abandoned，retryable failure 把 Step 送回 ready，stale terminal write fail closed。
  - event-sourced `RunGoalAccountingCursor` 按 Rust 口径只累计 uncached input + output，并保留整秒时间余量；普通 Tool
    finish 只结算 cursor 后增量，首次跨预算返回一次 `budgetLimited` handoff，Plan、stale 或 inactive attribution fail closed。
- `packages/context`：
  - provider-neutral、SDK-free 的 bounded prompt projection；clean history 保留原数组与 cache prefix。
  - orphan Tool result 删除、missing Tool result 补 Rust-compatible `aborted`，repair 只记录 kind/call ID，不复制
    Message、Tool input/output；任何 rewrite 都使 Provider checkpoint 失效并回到 manual replay。
  - 新 Authority 写入仍由 Store 严格拒绝 orphan/missing pair；normalization 不是持久化 malformed history 的后门。
- `packages/application`：
  - Application-owned `DomainStore = RunStore & ThreadStore & RunExecutionStore` Port；Store Adapter 不再拥有业务 Port。
  - server-derived Actor/Tenant/Space authorization context。
  - `createRun`、全部 Run transition、`getRun`、`listRunEvents`。
  - `createThread`、`appendMessage`、`getThread`、`listMessages`；公开追加固定为用户 Message，role 不能由客户端注入。
  - `getGoal` 会先验证 Thread tenant/space 与 `thread:goal:read` 授权，再返回精确 persistent Goal；跨 scope 不读取 Goal authority。
  - `setGoal/clearGoal/listGoalEvents` 已公开到授权 Application surface；幂等 replay 发生在 route resolution 前，pause/clear
    不依赖模型 route，显式 `tokenBudget=null` 的 unbounded 语义在 keep 时不会漂移回默认预算。
  - scoped idempotency fingerprint、optimistic revision、stable application error classification。
  - Application-owned `DurableQueueStore` Port；Outbox/Work Item claim、ack/complete、retry 与 lease fencing 不泄漏到
    Store implementation API 之外。
  - `RunExecutionService` 把 Kernel Event 映射为 durable Run Event，并定义 lease-fenced Run commit 和 text completion
    transaction boundary。
  - server-owned Goal Tool evaluator/Store Port 对齐 Rust `get_goal/create_goal/update_goal` 的安全投影、remaining token、
    complete/blocked 限制与 completion budget report；参数错误只回送模型，不修改 Goal。
  - 独立 `ModelHistoryStore` Port 以 provider-neutral `message|tool_call|tool_result` 作为模型上下文权威；Thread Message
    只保留展示/API 职责，不再由 Worker 拼装下一次模型输入。
  - Application-owned execution Port 已提供 Step/Attempt begin/load/list、retry 和 terminal commit；每个 model round 与
    Tool call 使用独立 Step，Attempt ID 独立生成，不复用队列 claim counter，也不把 Step ID 等同于 Work Item ID。
  - `ToolExecutionStore` 定义 Receipt prepare/dispatch/unknown/reconcile/cancel，以及完成结果与 Run Event、Model History、
    Tool Step/Attempt、Outbox、idempotency receipt 的组合事务边界。
  - 普通 Tool completion 现在把 Goal delta、下一版 Run accounting cursor 和首次预算耗尽 steering 放进同一 Store
    transaction；Worker 只在下一次模型采样前消费一次 steering。cancel 只结算并终止当前 Run，不自动创建 Goal continuation；
    generic failure -> blocked、usage limit -> usageLimited，与 Rust 终止矩阵一致。
  - Authorization deny/unavailable、malformed command、cross-tenant/cross-space 均 fail closed。
- `packages/store`：
  - In-memory 与 Node 24 built-in `node:sqlite` Adapter。
  - tenant-aware Thread/Message/Run Snapshot/Event/Outbox/Work Item/Tool Receipt schema、WAL、foreign key 和 schema version gate。
  - Run 通过 `run_thread_bindings` 强引用同 tenant、同 space、active Thread；不存在或越权 Thread 会使整笔 Run commit 回滚。
  - Event、Snapshot、Outbox、初始 `run.execute` Work Item、Idempotency Receipt 单事务提交。
  - Outbox `pending/leased/delivered`、Work Item `pending/leased/completed`，owner + lease ID + epoch + expiry fencing，
    durable retry delay 和 expired lease reclaim。
  - Work Item lease renewal 不改变 epoch；Worker 每次 Run mutation 都在同一个 Store transaction 内复核 work item scope、
    owner、lease ID、epoch 和 expiry。
  - SQLite v6 `run_steps`/`run_attempts` 是领域执行历史权威；Attempt number、`retryOfAttemptId`、lease epoch、failure、
    checkpoint digest 与 terminal time 独立持久化，Step 的 current Attempt 由 deferred foreign key 约束。
  - SQLite v7 `tool_execution_receipts` 在真实 Provider dispatch 前持久化 Action Digest、execution/idempotency identity、
    recovery policy 与 Provider receipt；mutation 未知结果只允许 reconcile，不会自动重放。
  - Goal Tool 使用已持久化的 `tool.requested` 作为恢复起点，在当前 Work Item lease 下把 Goal CAS 与 call-ID 幂等回执放入同一
    InMemory/SQLite/PostgreSQL transaction；崩溃恢复只重放原结果，不重复累计 token/time。该本地控制工具不进入外部 Tool receipt。
  - InMemory/SQLite/PostgreSQL 的普通 Tool completion 同一事务提交 Tool receipt/result history、Attempt、Run accounting event
    与 Goal CAS；PostgreSQL terminal 已改成 receipt-first replay，并统一为 idempotency -> Run -> Work Item -> Thread/Goal 锁序。
  - `thread_goals` 继续是当前状态/CAS 唯一 authority；独立 `thread_goal_events` 只承担 durable delivery/catch-up。external、
    TurnStart、Goal Tool、普通 Tool accounting、failed/canceled terminal 和 text completion 六类写路径均在同一事务追加恰好
    一条 changed/cleared event，幂等 replay 不重复追加；event page 出现 sequence gap 时 fail closed。
  - SQLite schema v17 与 PostgreSQL thread authority v3 持久化 Goal event log。SQLite v16 -> v17 和 PostgreSQL run
    authority v1 -> v2 都拒绝迁移仍在运行且缺少 durable accounting cursor 的 Goal-bound Run；PostgreSQL 门禁在任何
    Thread/Queue schema mutation 前执行，并在最终 Run table lock 内复审，避免拒绝切换后旧版本无法回滚。
  - retryable failure 将 Attempt→failed、Step→ready、Work Item→pending 原子提交；success/failure/cancel 将 Step/Attempt、
    Run terminal state、Outbox 和 Work Item→completed 原子提交，旧 epoch 不能完成当前 Attempt。
  - user/system Thread Message 与对应 Model History item 原子提交；Tool request 与 Model History call 原子提交；
    Tool Receipt completion、`tool.completed`、Model History result、Tool Step/Attempt、Outbox 与 idempotency receipt 原子提交；
    exact lost-response retry 返回 replay，变化的 completion payload fail closed；
    assistant Message、assistant Model History item、Thread Event/Snapshot、`message.completed`、`run.completed`、Run
    Snapshot、Outbox 和 Receipt 原子提交。
  - SQLite v1 -> v2 migration 保留 pending Outbox intent；v2 -> v3 从旧 Run state 回填 Thread 与 binding，跨 space/creator
    冲突 fail closed；v3 -> v4 新增 SDK-free Thread continuation；v4 -> v5 新增 Step/Attempt authority；v5 -> v6
    从 Message 回填 Canonical Model History，并把 continuation boundary 迁到 History sequence；v6 -> v7 新增 durable
    Tool execution receipt；JSON/结构化列一致性校验、
    真实文件重开恢复、事务中途失败回滚。
- `packages/test-contracts`：canonical trace comparator、显式 package dependency allowlist、所有 package 必须登记、
  runtime dependency graph 无环 Gate。
- `packages/control-client`：
  - 基于 generated Control API contract types 的零运行时依赖客户端，覆盖 Thread/Message/fork、Thread Goal 读取/set/clear、Run、
    AgentVersion 与 Tool Approval；固定 credentials、Origin、CSRF、idempotency 与 bounded pagination。Goal mutation 缺 CSRF 或
    Idempotency-Key 时在发送前 fail closed，tagged `tokenBudget: keep` 不会把已有 unbounded `null` 改写为默认预算。
  - fetch-based bounded SSE reader 支持 fragmented CRLF、`Last-Event-ID`、client/audit view、frame/buffer hard cap 与严格
    event identity；客户端不暴露 generic authenticated fetch，malformed remote body 只返回 content-free protocol code。
  - 独立 Goal SSE consumer 使用 Thread 范围 event sequence 自动断线续读，clear 不终止流；新 Goal revision 可从 1 重启但 sequence
    必须连续。公共投影严格拒绝 tenant/Run/cross-shape 数据，单 frame 128KiB、未解析 buffer 256KiB。
  - Goal GET 返回同一 Store 读点的 `{goal,eventSequence}`，客户端以该 sequence 作为 Goal SSE 的初始 `Last-Event-ID`；mutation 的
    `expectedRevision` 仍是 Goal revision，不能与 delivery cursor 混用。
- `packages/agent-kernel`：
  - CrewON-owned bounded segment loop 与 `AgentKernelPort`；Transport 只产生 model transport event，不拥有 durable state。
  - context/output/delta hard cap、canonical ordering、usage invariant、AbortSignal 与 malformed stream fail closed。
  - deterministic fake 无网络、无 sleep，并通过共享 Rust-reference text trace comparator。
  - early EOF/可重试 transport error 在同一 Segment/Attempt 内重试；默认 5、硬上限 100、200ms 指数退避与 ±10%
    jitter 对齐 Rust。每次重试产生安全的 `model.sampling.retry` durable progress event；已有 partial delta 时显式
    `discardedOutput=true`，审计保留失败采样但 replay/final Message 只使用成功采样。
  - provider-neutral structured Model input 已覆盖 Message、function/custom Tool call 与 Tool result；Kernel 只做一次
    bounded model sample，并在 Tool boundary 交还 Worker，不拥有 Tool execution 或隐藏的 follow-up loop。
  - Segment contract 直接接收 Canonical Model History；Tool call ID/pairing/orphan result 与 context byte cap fail closed。
  - Segment 可接收服务端 runtime Tool definitions；它们与 immutable AgentVersion Tool 合并后再应用 allow-list，同名身份碰撞
    fail closed，compaction 与 Plan 不会因此获得 Goal mutation Tool。
- `packages/tool-broker`：
  - 严格 bounded Tool Catalog 与 Worker-side `execute/reconcile/cancel` Port；稳定 execution/idempotency identity、
    conflict fencing、AbortSignal 和安全错误输出。
  - unknown custom Tool 对齐 Rust exact output；process output 保留 exit code/wall time/plain output，非零退出仍回送模型决定。
  - resolved `serial|parallel` policy；默认/未知串行，parallel-safe 调用可并发执行但 completion/result 顺序仍按 call order。
  - model-visible Tool output 限约 40KB（约 10K tokens），保留 head/tail/marker；超限 raw output 必须先进入权威 Artifact，
    Provider 提供的引用也必须通过 exact provenance + digest/size 校验。
  - Provider command 现携带 durable Work Item、Step/Attempt、lease ID/epoch 与数据库续租 expiry；远端执行 Adapter 不再需要
    伪造调度身份或读取 Worker 环境。非法 lease 在任何 Provider dispatch 前 fail closed。
- `packages/device-dispatch`：
  - `DeviceToolRuntime` 把完整 Tool command 映射为 signed Device command，严格核对 policy/Action Digest/Approval、
    tenant-scoped binding、renewed lease、workspace/capability/limits，并保留独立 `execute/reconcile/cancel` remote operation。
  - 开源 `Ed25519DeviceCommandSigner` 只接受 Ed25519 private key，授权 TTL 不超过 durable lease expiry；签名后任何 command
    mutation 都会失败。Tool 内部 idempotency key 映射为稳定 `device:<action-sha256>`，不放宽 Device opaque-ID 协议。
  - Worker 侧 `HttpsDeviceDispatchClient` 强制 TLS 1.3/mTLS、bounded response 和 operation echo；显式 runtime config 绑定
    definitions/policies/Device IDs/mTLS/签名路径，mutation 必须 `perAction`。Gateway 侧已有 single-flight、cancel/reconcile、
    SQLite prepared/terminal authority、真实 WebSocket terminal replay，以及原 command lease/authorization 有效期内由
    `lastAcknowledged` 显式证明的 active reconnect。Team PostgreSQL authority 已支持异步 Store Port、schema migration、
    双 Pool initial-send single-flight、terminal conflict serialization 和 connection route epoch fencing；旧 Gateway heartbeat
    不能续租新 epoch 并会关闭旧 Session。独立 Gateway mTLS role、静态 HTTPS peer registry、strict single-hop forwarding 与
    target-side route fence recheck 已接 production entrypoint；Gateway route claim 后发送 TS/Rust 共享 fixture 覆盖的
    `crewon.device-welcome.v0` connection epoch。最小 Rust `crewon-device` 已提供 bounded raw frame、轮换 Ed25519 PEM key、
    signature/expiry recheck、append-only highest-epoch fence 和 side-effect-start permit；本机双 Gateway 子进程的 owner `SIGKILL`
    后 reconcile/cancel 也已通过，但尚未接入真实 Native WSS/UDS capability dispatcher，因此仍没有完整生产 HA、长断线授权续期、
    HSM/KMS 或 native Device。
- `packages/agent-responses`：
  - 不依赖 SDK 的 Direct Responses-compatible HTTP/SSE Adapter；平台 `fetch` 和自有 bounded parser，不允许 Provider
    类型进入 Kernel、domain、Store 或 wire contract。
  - manual full-history 与 `previous_response_id` continuation 是互斥联合；provider storage 默认关闭，previous-response
    模式必须显式启用 storage，避免同时重复发送历史。
  - Responses function/custom Tool definitions、call、arguments/input 与 call output 使用 structured items，不把 Tool 协议塞入
    文本 Message；same-loop Tool schema 在两次 request 间稳定。
  - 严格 `response.created`/sequence/terminal ordering、text delta、final output、usage invariant、SSE frame cap；意外 Tool
    event、malformed JSON、缺失 usage、提前 EOF/`[DONE]` 均 fail closed。
  - HTTP 与 stream error taxonomy 区分 authentication、permission、invalid request、rate limit、timeout、unavailable、
    protocol 和 incomplete；错误不携带 raw provider body，bounded `Retry-After` 进入 durable retry delay。
  - bounded 429 body 只用于安全分类：`usage_limit_reached` 与普通 429 分离，前者不可重试；兼容 Rust header family 的
    provider-neutral rate-limit snapshot 经过严格 contract 验证后进入 durable `rate_limit.updated`，raw body/message 不入事件。
  - 调用方 AbortSignal 和 idle timeout 会主动 abort 正在进行的 fetch/body；API key 可空，自托管端点是显式一等路径。
  - `crewon.provider-checkpoint.v0` 只含 adapter/version/model + bounded opaque JSON；Direct Adapter 只解释自己版本的
    response ID，Kernel/domain/Store 不依赖 OpenAI SDK 类型。
- `apps/control-api`：
  - Fastify REST composition root；Standalone identity、CSRF、Origin、loopback、authorization 和 server-owned route。
  - `POST /threads`、`GET /threads/{threadId}`、`GET /threads/{threadId}/goal`、`POST/GET /threads/{threadId}/messages`；以及 `POST /runs`、
    `GET /runs/{runId}`、`POST /runs/{runId}:cancel`、health。
  - SQLite durable catch-up + bounded in-process live SSE；SSE id 是 Run sequence，支持 `Last-Event-ID`。
  - `PUT/DELETE /threads/{threadId}/goal` 使用强制 CSRF、Idempotency-Key 和 expected revision；响应只投影安全 Goal/Run
    字段。`GET /threads/{threadId}/goal/events` 从 durable Goal event log catch-up 后周期轮询数据库，clear 不终止流；慢客户端
    等待 `drain`，只有成功写出后才推进 cursor。
  - `GET /threads/{threadId}/goal` 通过 InMemory 同步读点或 SQLite/PostgreSQL 单条 SQL 原子返回 Goal snapshot 与 durable event
    sequence，消除首次 snapshot -> SSE 之间的 replay/漏读窗口。
  - `POST /threads/{threadId}:archive` 通过 expected revision、CSRF、Idempotency-Key 提交现有 `thread.archived` authority；
    snapshot、Thread event 和 receipt 同事务，`GET /threads/{threadId}/events` 以独立 sequence/`Last-Event-ID` durable catch-up。
  - Outbox dispatcher 通过 claim -> load committed Event -> publish hub -> ack 工作；周期数据库 scan 是外部提交的
    correctness path，command 后 wake 仅用于降低延迟。
  - public Thread/Message/Run/Event projection 不暴露 tenant、space、actor、authority、runtime、policy、workspace binding、
    content digest 或 action digest。
  - UUIDv7、稳定安全错误 envelope，以及 production transitive license allowlist Gate。
  - tenant-scoped AgentVersion publish/get/list 与 default/optional selected-version Run；服务端重算 durable source digest，并以
    `agentVersionId + contentDigest + authorityId + workspaceBindingId` exact admission 派生路线，客户端不能注入 Provider、
    runtime generation、policy 或 authority。默认 ID 和显式 ID 都只读同一 durable Deployment，失败时不会互相回退；readiness
    同时要求默认 asset/deployment 已激活且 content digest 一致，不能用“数据库可连”冒充可运行。
  - `CREWON_CONTROL_SECURITY_MODE=production` 使用独立 PostgreSQL composition：BFF service credential 与短期用户 token 分离，
    Actor 只来自 bounded HTTPS identity assertion；issuer/audience/time/scope 二次校验，权限逐请求走动态 Policy authority，
    跨 tenant/space 先本地 deny。production route 按当前 actor tenant 的 active release 解析，不再携带 process-wide fixed actor。
- `apps/web-bff`：
  - Node 24 标准库 BFF 提供同源 `/control-api/session` 与 `/api/v1` streaming proxy；浏览器只得到 HMAC CSRF，HttpOnly session、
    user Control bearer、BFF service credential 与 Control CSRF 均留在服务端。nginx/BFF 双重移除浏览器伪造 authority header。
  - production source Gate 要求 request-scoped Control identity/authorization 与独立 BFF credential 已接线；当前 Gate 通过，但尚未
    连接真实 Identity/PIM staging，不能据此声明 live production identity 已通过。
- `apps/runtime-worker`：
  - 独立 TypeScript 进程领取 `run.execute`，重读 canonical Run/Thread/cancel，复核 pinned route/policy，再调用 bounded Kernel。
  - queued→running、Agent Event、terminal Message/Run、Work Item settle/retry 全部带 lease fence 与 scoped idempotency。
  - policy mismatch 在调用模型前 fail closed；durable cancellation watcher 独立于 model event 重读权威 Run，可中断
    完全不 yield 的 blocked fetch/body。
  - 默认启动路径是 `responses`；官方 endpoint 可带 key，自托管 endpoint 可无 key。`deterministic-fake` 仍只用于
    deterministic correctness，不冒充生产模型。
  - classified provider `Retry-After` 覆盖默认 Work Item retry delay；独立 production dependency license Gate 继续通过。
  - sampling retry 与 durable Attempt recovery 已分层：同 Turn Provider retry 共用一个 Attempt；预算耗尽后 terminal-fail
    当前 Run/Work Item，只有 crash/lease reclaim 或事务恢复才创建 `retryOfAttemptId`。focused test 证明 2 个 Provider
    requests 最终只有 1 个 completed Attempt。
  - provider checkpoint、`segment.checkpointed`、`segment.completed`、assistant Message、Thread/Run terminal state 和 Outbox
    同一 fenced transaction 晋升；失败时 response ID 不会成为 continuation authority。
  - 独立 `release` 进程在执行前经 `agentVersion:publish/deploy` 授权，把 bootstrap AgentVersion 与所有 binding activation
    写入 exact tenant Store；Worker 只读核验，缺失或同 ID 不同内容均拒绝启动。durable resolver 按
    `tenantId + agentVersionId` single-flight 加载并重算 digest；严格 runtime manifest 可为每个版本建立独立 Provider、
    credential env、request profile、workspace 和 stdio MCP runtime，缺失/漂移不会借用当前版本。
  - 每个进入 running model execution 的有效 lease 创建独立 Attempt；crash reclaim 会把旧 running Attempt 标为
    abandoned，并以 `retryOfAttemptId` 连接新 Attempt。Attempt-scoped segment ID 防止不同 retry 的 Agent Event 被错误
    当成同一幂等命令；queued 阶段取消或 policy deny 不伪造 model Attempt。
  - Kernel 在 Tool boundary 返回后，Worker 按 call 建立独立 Tool Step/Attempt 与 durable Receipt，再调用 Provider；
    serial/parallel 只影响执行并发，结果始终按模型 call order 提交。Provider-completed crash 通过 reconcile 恢复，
    不可证明的 mutation 进入 `reconciling`；Provider 确认后的 resume/result 使用组合事务提交。
  - `reconciling` Run 收到 cancel 后不会直接 terminalize；Worker 调用同一 Provider/Device 的 `cancel`，unknown 继续保持
    `reconciling + cancelRequested`，只有 Provider 证明 canceled 或 completed 后才结束 Run。
  - default Run 会获得 server-owned `get_goal/create_goal`，immutable Goal-bound Run 另获得 `update_goal`。Worker 串行执行
    Goal authority，先落
    幂等 Goal 回执、再追加 `tool.completed`/Model History；两者之间进程丢失可恢复。Goal Tool 不经过 AgentVersion runtime 或
    外部 Provider，与外部 Tool 同批调用、AgentVersion 同名定义都 fail closed。
- CI：Node 24 固定版本，所有新架构 package 的 typecheck/test。
- CrewON packaged desktop：
  - Tauri 用 typed IPC 只在 renderer 内存交接 256-bit session/CSRF；macOS arm64 `.app` 已打包官方校验过的 Node 24 和
    Control/release/Worker ESM，按 release activation -> Control ready -> Worker ready 顺序启动，并在任一子进程退出或 App Exit
    时回收兄弟进程。真实实包 ready=200、强杀 Worker 后 Control 关闭、退出后 orphan=0 已验证。
  - OS Keychain Provider credential、catalog/keyring compensation、active-Run admission fence、Control/Worker 双进程 replacement
    已通过 macOS Tauri Gate；当前包仍保留旧 app-server 供未迁移外围能力使用，Windows/NSIS、正式签名/updater、live Provider
    canary 与真实 Identity/PIM 尚未验收。
- Renderer 编译边界：CrewON UI 使用私有空 `typeRoots/node`，避免 workspace 中 server package 的
  `@types/node` 把浏览器 `setTimeout` 等 API 污染为 Node 类型；production import Gate 继续禁止 renderer 引入
  Node/server/store 模块。

## 当前验证证据

```text
contracts        37 tests
context          12 tests
domain           58 tests
application      47 tests
artifacts         5 tests
tool-broker      12 tests
mcp-runtime       4 tests
agent-kernel     17 tests
agent-responses  27 tests
agent-version     5 tests
legacy-importer   2 tests
store           257 tests
test-contracts   15 tests
control-client   24 tests
device-dispatch   8 tests
control-api      42 tests
runtime-worker  121 tests
device-gateway   46 tests
web-bff          15 tests
total           754 tests
```

以上 754 项由 `pnpm -r --filter '!@crewon/ui' --if-present test` 在本机 Node 24 与隔离 PostgreSQL 15 上整组运行，20 个新架构/
服务项目均通过，0 failed、0 skipped；workspace typecheck 同时为 20/20，CrewON UI 的独立 TypeScript lint 也通过。完整 UI test
当前因既有 workbench CSS 与 snapshot 未同步而停在 1695 passed、1 snapshot failed；该 UI 失败不属于本批 Goal/runtime 改动，未擅自
接受快照，也不能据此声称整个产品 UI 已通过。

另有 Rust `crewon-device-protocol` shared-fixture conformance `1/1`，以及 `crewon-device` Native admission/fence `10/10`，
均不计入上面的 TS test total。

Thread/Run Store 与 Application conformance 同时运行于 InMemory 和 SQLite。SQLite 另以真实临时数据库文件验证：
Thread/Message/Run 关闭重开、application continuation、WAL/foreign key、schema version protection、v1/v2 migration、
跨空间 Thread 回填冲突、强制 Outbox 写失败后的全事务回滚，以及 JSON/column corruption fail closed。Queue conformance
还覆盖无 sleep retry、exact-expiry reclaim、单调 lease epoch、
stale owner settlement rejection、Work Item complete，以及持有未结 lease 时关闭进程、重开后由新 owner reclaim。
两个独立 SQLite connection 同时 claim 同一 Outbox 时也只有一个获得 lease；这只证明本地数据库原子性，不等于
PostgreSQL 多节点调度验收。

PostgreSQL queue foundation 另在隔离 PostgreSQL 15 上运行同一进程内的两个独立 `pg` Pool：advisory-lock migration 可并发，
一个事务显式锁住队首时另一 Worker 通过 `FOR UPDATE SKIP LOCKED` 领取第二项，lease expiry/renew/retry/settle 均读取数据库
时间并以 epoch fence stale owner。focused `3/3` 无 skip、无 sleep；该 queue 现已由完整 PostgreSQL DomainStore 与真实
Runtime Worker 消费，但仍不代表 LISTEN/NOTIFY、备份恢复或 production PostgreSQL。

同一隔离 PostgreSQL 15 上，Thread Authority 进一步消费与 InMemory/SQLite 相同的 conformance：Thread snapshot/event、
Message、canonical Model History 和 idempotency receipt 同事务写入，fork source revision 由排序 aggregate advisory lock 和
row lock 共同 fencing；跨 tenant 查询仍返回 null/empty。focused `6/6`，包含两个独立 Pool 对同一幂等提交的
`committed + replayed` 单写证据。

PostgreSQL Run Authority 继续通过 Store conformance、真实 `RunApplicationService` 与双 Pool 竞争 `14/14`：Run
snapshot/event、Thread binding、idempotency receipt、Outbox、Work Item 在一笔事务提交，queue 外键拒绝 orphan handoff。
Step/Attempt foundation 证明数据库时间 lease 下同一 Work Item 可承载独立 Model/Tool Step；lease 到期后新 Pool reclaim 会把
旧 Attempt 标记 abandoned 并保存 retry lineage。PostgreSQL execution schema v5 新增 continuation、Tool receipt、Approval 与
ThreadModelState，并验证 v1 原地升级及高版本 schema 在任何 execution DDL 前 fail closed。完整 execution conformance 覆盖 text completion/replay、Tool
receipt/unknown outcome/reconciliation、Approval hold/wake/expire/supersede、context compaction、terminal settlement、队列
release 以及每类 Outbox 冲突全事务 rollback。Model History 追加只读取 head、最多 128 个 pending Tool call 与本次 call keys。

Runtime Worker 在 `PostgresDomainStore` 上通过同一套 `8/8` conformance。Control API 与 Worker composition 都支持
`CREWON_CONTROL_DATABASE_URL` 和显式 schema；两个真实 Worker 子进程竞争一个 Run 时只有一个 `completed`、另一个 `idle`，
只创建一个 Attempt。另一个 PostgreSQL 进程用例在 Attempt durable 后 SIGKILL 首个 Worker，新进程 reclaim 后形成
`abandoned -> retryOf -> completed`，最终 assistant Message 只出现一次。AgentVersion PostgreSQL conformance 现固定使用非零
毫秒 timestamp；多进程启动发现并修复了 `pg` 将 `timestamptz` 解码为 `Date` 后经字符串转换丢失毫秒的误判，回归覆盖
bootstrap registration 的 existing 路径。

Control API 以真实 loopback HTTP 和真实 SQLite 文件验证：创建 Thread、追加 text Message、用该 Thread 创建 Run、
live SSE sequence 1、cancel 后 live sequence 2、关闭/重开服务、重新读取 Message、`Last-Event-ID: 1` 只补 sequence 2。
测试不使用 sleep；另有上述两条 PostgreSQL 多进程纵向用例。Control API 当前合计 `18/18`，包含两个真实 Worker
竞争与 SIGKILL/reclaim。默认 SSE `view=client` 隐藏未耗尽预算的首次 WebSocket retry，`view=audit` 保留全部事件。

独立进程测试在 `run.started` 和 Attempt durable commit 后对 Worker 发送真实 `SIGKILL`，确认 Run 保持 running、assistant
Message 未伪造；随后显式推进已由 Store conformance 单独证明的 lease-expiry 条件，启动第二个 Worker 进程完成同一 Work
Item。数据库证据同时证明 Attempt 1→abandoned、Attempt 2→completed 且 `retryOfAttemptId` 指向 Attempt 1。Control API 的
既有 live SSE 在进程边界外收到连续 sequence 2–8，最终 Thread 同时出现 assistant Message。另有 SQLite trigger 强制
assistant Message insert 失败，证明 terminal Run/Thread/Message/Step/Attempt/Outbox/Work Item 整笔回滚；随后 Attempt 1
以 retryable failure 结束，Attempt 2 使用独立 segment 重放并完成。两项测试都不使用 sleep。

Direct Responses 另以真实 loopback HTTP server 验证无 API key 的 self-hosted request、fragmented CRLF SSE、严格 sequence、
delta/final output/usage 和 terminal mapping；Kernel 与 Worker 各有一条 Direct transport conformance。主动 caller abort 与
idle timeout 使用可控 signal/scheduler，无 sleep。HTTP 429 测试证明 safe error 不暴露 provider body，且 2 秒
`Retry-After` 实际延后 durable Work Item reclaim。这些都是本机 compatible server/contract 证据，不是 live OpenAI 验收。

AR-007 `responses-lite-request.reference.json` 同时由 Rust request integration 与 TS HTTP/WebSocket transport 消费；只有显式
`CREWON_RESPONSES_REQUEST_PROFILE=responsesLite` 才发送 `reasoning.context=all_turns` 和
`parallel_tool_calls=false`，默认 `standard` 保持 self-hosted request 不含 OpenAI 特定字段。Rust focused `1/1`、TS profile
focused `3/3` 通过。`websocket-transport.reference.json` 进一步冻结 AR-004 initial + 2 retry 后 fallback、AR-005 下一 Turn
sticky HTTP，以及 AR-011 单连接增量 suffix + `previous_response_id`；Rust fallback `4/4`、incremental `1/1` 与 TS Agent
Responses `26/26` 通过。AR-006 的 durable audit `[1,2]` 与默认 client projection `[2]` 已由同一 fixture 验证，
不再依赖 debug/release build mode。

AR-026/027 `legacy-rollout-resume-fork.reference.json` 同时驱动 Rust resume、Rust compact/resume/fork 和新的
`packages/legacy-rollout-importer`。importer 只生成一次性 Thread transaction，不被 Control API/Worker 正常路径引用；
它从 response/replacement history 重建模型上下文、从 event_msg 重建 UI Message。真实 SQLite commit/replay、关闭重开 resume、
Thread fork 与两条分支追加后保持相同 model-visible prefix；无法无损表达的 legacy item fail closed。

AR-030 `typed-policy-failure.reference.json` 同时驱动 Rust、Direct Responses 与 Runtime Worker；`cyber_policy` 不再退化为
通用 400，固定为不可重试的 `responses_provider_cyber_policy`，单请求、0 sampling retry、无 assistant Message 并释放 Work Item。

AR-025 `context-window-compaction.reference.json` 同时由 Rust manual compaction、TS Direct Responses/Kernel compactor 和
SQLite Runtime Worker 纵向路径消费。SSE 或 bounded HTTP 400 的 `context_length_exceeded` 会映射为安全稳定 code；compactor
每次只删除一个最老 history item、保留相同 prompt 并在同一 durable Compaction Attempt 内重试，成功前不会写入 compacted
history。Rust focused `1/1`；TS Adapter、compactor unit 与 SQLite durable/restart 链路通过。

AR-012 `prompt-tool-stability.reference.json` 同时由 Rust prompt integration 与 TS owned Kernel 消费。TS Kernel 在构造时
固定 bounded instructions 和有序 Tool definition，Runtime Worker 使用同一份 Tool 快照执行，HTTP/WebSocket 请求均从该
不可变请求对象生成；进程内 Tool refresh 不会破坏 cache prefix 或造成 advertised/executable Tool 漂移。生产 composition
现会在 Store open 与 Provider prewarm 前编译 AgentVersion：instructions、transport/model identity、context window、compaction、
retry/Tool-round policy、governed context digest 与 Tool 顺序共同生成 content digest；部署可用 expected digest 对同 ID 漂移 fail closed。
AgentVersion 现以 tenant-scoped immutable asset 持久化到 SQLite schema v16 与独立 PostgreSQL
`agent_version_authority`；Control API 支持经身份和授权后的 publish/get/list，重复相同 content 返回 existing，同 ID 内容漂移
返回 conflict。读取 durable definition 时会重建 source 并重算 SHA-256，不能只信数据库中的摘要字段。独立 release composition
在不构造 Worker 的情况下编译 bootstrap 和 runtime binding materialization，通过专用 release identity 与
`agentVersion:publish/deploy` 权限激活；binding release metadata 的编译不读取 Provider credential。Worker registry 按
`tenantId + agentVersionId` 解析；启动只验证已激活 asset/deployment，durable lazy-load single-flight 与旧版本 prior compactor
均重验 definition digest。缺失 runtime 会释放 lease 并延迟重试，不会用当前版本 silent fallback。Control API 可按 exact
ID/digest/authority/workspace admission 创建 default 或 selected-version Run；runtime manifest 为不同版本实例化独立 transport/model/Tool/
governed-context runtime。SQLite v16/PostgreSQL authority v3 保留 tenant/version 级 immutable `AgentVersionDeployment`，并新增
digest-addressed release bundle、operator activation audit 与 tenant active pointer：只有同一
tenant/version 的 AgentVersion asset 已存在且 content digest 一致时才能注册；数据库外键拒绝 orphan。Worker 把 Provider binding
及 bounded MCP/Device 配置正文的 canonical projection 编译为 materialization digest，并在真正 materialize 前复算；路径下内容漂移、
content/materialization/authority/workspace 重绑都会 fail closed。单 Deployment 写 API 已删除；release command 在一个事务内写入
bundle、全部 Deployment、operator audit 和 CAS active pointer，SQLite/PostgreSQL 均以第二条 Deployment 强制失败证明无部分状态，
PostgreSQL 双连接并发 activation 只有一个成功。Control 对缺省/显式 ID 只接受 active bundle；rollback 命令不加载 Provider，
只写新 activation 并切换 pointer。Worker 可验证 historical bundle，确保 rollback 前已创建的 pinned Run 仍能在重启后完成。

AR-023 `token-limit-compaction.reference.json` 冻结同一 Run 的
`model -> compact -> model -> compact -> model -> compact -> model` 七请求序列。Worker 只在完成 Tool round 后读取最近一次
durable `usage.recorded`，达到阈值即创建独立 compaction Step/Attempt 并继续原 Run；`context.compacted` 会清空旧 usage trigger，
因此可以多次压缩但不会因陈旧计数死循环。阈值目前由 `CREWON_AUTO_COMPACT_AT_TOKENS` 注入，最终必须进入不可变 AgentVersion
模型策略。

AR-029 `governed-context.reference.json` 由 Rust Responses integration、TS governed assembler 和 Runtime Worker Tool-round
纵向路径共同消费。每个 fragment 固定 audience/provenance/trust/sensitivity/purpose/freshness、10K token hard cap、原文与投影
SHA-256；trusted application 映射 `developer`，Provider/User/Memory/Tool/Web 保持 `user`，secret 与伪造 trusted provider
fail closed。转义后的有序 prefix 在连续请求保持稳定，并计入 Worker 全局 item/byte budget；具体 Resource/Memory loader
仍须通过 AgentVersion 编译器注入，不能绕过该 bundle 直写模型 history。

Goal/Plan 纵向切片已把 persistent `ThreadGoal`、Run `collaborationMode` 与 immutable `goalBinding` 纳入 DomainStore。
`turn/start` 在 InMemory/SQLite/PostgreSQL 同一 transaction 中执行 Goal CAS、user Message、Model History、Run、Outbox 与
Work Item：Goal intent 创建或更新并激活 Goal，Plan intent 清 Goal且固定单次 Run 为 Plan，receipt replay 不读取当前 Goal。
Run snapshot 进一步累加 sampling 与 context compaction usage，并保留 `cachedInputTokens`；旧 event/snapshot 缺该字段时规范化为
0，非法值或 cached 大于 input 继续 fail closed。Goal token 口径对齐 Rust，只计 `input - cached + output`。
text completion、cancel 和 failure terminal transaction 会同时 CAS Goal：成功保留 active，token budget 达线转
`budgetLimited`，不可恢复错误转 `blocked`，`responses_usage_limit_reached` 转 `usageLimited`。finite-budget active Goal 的 text
success 会在相同 transaction 中生成下一 Run、只进入 Model History 的 `goal_continuation` user context、Outbox 与 Work Item；
它不增加 Thread Message。下一 Worker 在采样前核对 Goal ID/revision/objective digest。新 TS Goal 默认 safety budget 为
`200000`；显式 unbounded Goal 也会跨多轮 durable continuation 自动续跑。
SQLite schema 已升至 v17，PostgreSQL thread authority 升至 v3、run authority 升至 v2；隔离 PostgreSQL 15 已实际运行完整
Store `257/257`、Runtime Worker `121/121` 与 Control API `42/42`，均为 0 skipped。真实数据库 Gate 发现并修复
`goalActivation` Work Item 三态解码、terminal receipt replay 内部 envelope 泄漏和跨 schema advisory-lock 探针误判；Goal SSE 另以
真实 PostgreSQL 验证 clear 后新 Goal revision 重置为 1、Thread event sequence 继续且 `Last-Event-ID` 正确续读。这些仍是本机隔离
数据库证据，不外推为 staging/production、备份恢复、跨主机分区或 SLO。Control OpenAPI/generated client 已传递
`executionIntent`，公开 Run 投影包含模式与 Goal binding；UI 已在取得 Control session 时切换到该 Control adapter，但尚未默认删除
legacy client。Worker 为 Plan 注入 server-owned instructions，只广告 execution policy
判定为 read-only 的 Tool，执行边界再次拒绝 mutation，并只接受唯一非空 `<proposed_plan>` 终态。default 且 Goal-bound 的
Run 现由 Kernel 注入 server-owned `get_goal/create_goal/update_goal`；Tool 名称不会进入 AgentVersion/Provider authority。`update_goal`
在一笔 fenced Store transaction 中结算 Run 累计 usage/time、CAS complete/blocked 并写 call-ID 回执，随后 Worker 追加
`tool.completed`；两步之间崩溃会重放回执而不重复计费。complete/blocked 后 terminal text 不再续建 Goal Run。`create_goal`
会创建新 Goal，但不改变当前 Run 的 immutable binding，也不追溯当前 Run usage；terminal text transaction 创建下一条 Goal-bound
Run，下一 Run 才开始计费。未显式提供 budget 时应用 `200000` safety budget。continuation 的 Goal admission 只在 queued 阶段验证；
进入 running 后，本 Run 调用 `update_goal` 导致的 revision 变化不会阻止后续 terminal model segment 或 crash recovery。
Control API 与生成 contract 已有授权的 Goal GET/PUT/DELETE 以及独立 Goal event SSE；公开投影保留后续 optimistic mutation
所需的 Goal ID/revision，但不含 tenant/space/actor，Application 在每次读取或 SSE poll 前验证 Thread scope 与权限。直接
set/clear 的 Application command 与三种 Store compound transaction 会原子处理 Goal CAS、回执、queued Goal-owned Run 退休、lease
settlement 与 replacement activation，并保留普通 queued user Turn；PostgreSQL Goal mutation 锁序固定为 receipt -> expected Run ->
WorkItem -> Thread active fence。running/queued manual Run 已有 event-sourced accounting cursor：external mutation 在同一 transaction
结算旧 attribution、推进完整 RunUsage watermark、rebind/detach；旧 bound non-terminal snapshot 缺 cursor 会在 schema cutover 前
要求 drain，不能被静默规范化为零。objective steering 使用 bounded `goal_steering` Model History item，Worker 只在 pending Tool 完成后、
下一次模型请求前原子消费，InMemory/SQLite 集成测试证明只注入一次。text/failure/cancel terminal 与 `update_goal` 已改为 cursor delta
并在 terminal 前关闭 accounting interval；Goal Tool receipt 同时保存最终 Run、event 与 outbox。六类 Goal writer 另在同一事务
写入独立 `thread_goal_events`，SSE 通过 sequence catch-up 和数据库 polling 恢复，clear 后新 Goal revision 从 1 开始但 event
sequence 不重置。PostgreSQL terminal、Goal Tool 与 TurnStart 均已实现 receipt-first replay 和 run -> thread 锁序。
Objective admission 已对齐 4000 Unicode scalar；Rust 与 TS 的 continuation/objective-update/budget-limit 都会 XML escape，并把包含
runtime marker 的完整 model item 限制在 9999 UTF-8 bytes，截断时要求模型调用 `get_goal` 恢复完整 objective。Plan 专用 stream/UI
item 仍未完成，因此整个迁移仍未完成，但 Goal runtime focused Gate 已是 `PARITY（含 intentional redesign）`。
本批 evidence：workspace typecheck `20/20`，UI TypeScript lint 通过；19 个有测试脚本的新架构/服务包 `780/780` 且真实 PostgreSQL 路径
0 skipped；Rust focused
`crewon-goal-extension 26/26`、`crewon-state 242/242`、`crewon-app-server thread_goal 5/5`。两份 bounded shared fixture 已由 Rust 与 TS
共同消费：continuation 行为语义，以及 Tool/budget、terminal precedence、objective edit/clear、幂等与不可复活。`timeUsedSeconds`
明确采用 Goal-attributed started-Run elapsed 的 intentional redesign，queued/跨 Run idle 不计入，Rust 历史值只作 seed 保留。
旧 Run snapshot 兼容只接受 `collaborationMode` 与 `goalBinding` 同时缺失，并规范化为 `default + null`；任何半迁移或非法组合
都拒绝读取。

AR-024 `model-switch-compaction.reference.json` 冻结 `large model -> large model compact -> small model`。文本完成把
AgentVersion/adapter/model、context window、compact threshold、latest usage、history boundary 与 revision 写入唯一
`ThreadModelState`，并和所有终态 authority 同事务提交；SQLite 当前 schema v17（ThreadModelState 在 v12 引入）与 PostgreSQL
execution schema v5 共用 Store
conformance。下一 Run 切换到更小窗口且超过新阈值时，Worker 通过 prior-runtime resolver 使用旧 AgentVersion compactor，
只替换旧 history prefix、保留已追加的新 user Message；durable replaces boundary 使 crash/reclaim 后不重复 compact。resolver
缺失时 fail closed，不会降级为小模型直接采样。resolver 现可从 tenant-scoped durable AgentVersion 懒加载旧 runtime；配置化
factory 以 exact digest 选择独立 Provider/Tool/context，并在返回 runtime 前核对 adapter/model/workspace 与 prewarm。

Rust `stream_no_completed.rs` 直接消费两份共享 AR-002 fixture：一份覆盖 terminal 前 early close，另一份覆盖已经产生
`draft` delta 后断流；两者都验证两次 request、一次 reconnect、delta 顺序、未完成 item discard 和最终 `done`。TS
candidate 对同一 fixture 自动 deep-equal；Worker focused test 进一步证明这 2 个 request 共用一个 durable Attempt，并且
最终 assistant Message 只有 `done` 而不是 `draftdone`。Rust focused suite 2/2、TS Agent Kernel 10/10。

AR-003 `turn-error-release.reference.json` 同时由 Rust `stream_error_allows_next_turn` 与 TS Worker 消费。Provider sampling
retry 预算耗尽后，TS 不再把相同 Provider error 无限升级为新 durable Attempt，而是以 non-retryable execution decision
终止 Run/Step/Attempt/Work Item；同一 Thread 的下一 Run 随后完成。Rust 1/1、TS two-Run fixture 1/1。

AR-008 `usage-limit-reached.reference.json` 同时由 Rust `usage_limit_error_emits_rate_limit_event`、Direct Responses Adapter
与 Worker 消费：安全 snapshot、不可重试错误、单次 request、0 次 sampling retry、无 assistant Message 和执行槽释放完全
一致。AR-009 `content-filter-incomplete.reference.json` 同时冻结 partial delta、content-filter failure、无 assistant Message
commit 与 Turn/Work Item release。Rust focused AR-008 2/2（含既有 WebSocket 同名 case）、AR-009 1/1；TS 对应 focused
fixtures 均通过。

AR-013 `unknown-custom-tool.reference.json` 已由 Rust `custom_tool_unknown_returns_custom_output_error`、TS Kernel 和 Worker
共同消费，验证两次 model request、一次幂等 Tool invocation 和最终 `done`。AR-014/015 的成功 JSON 与非零退出输出由
两条 Rust shell serialization test 和 Tool Broker 共用 `shell-tool-output.reference.json`。AR-016 normalized truncation fixture
同时验证 Rust 与 TS 都保留 plain text/head/tail/marker 且不超过约 10K-token budget。AR-020 Tool cancel fixture 在 Rust
TurnAborted 与 TS durable Run cancel 两侧均通过，TS 使用可控 scheduler，无 sleep。AR-010 与 AR-021/022 进一步用
`canonical-history-dedupe.reference.json`、`aborted-tool-history.reference.json` 对比 Rust `/responses` 与 TS SQLite
关闭重开后的下一次请求，三个 focused Rust tests 均通过。

AR-028 `context-normalization.reference.json` 同时由 Rust `ContextManager` 与 `packages/context` 消费；Rust debug 保持现有
fail-fast，release 规则删除 orphan output、为 missing call 补 `aborted`。TS clean projection 不重写数组；发生 repair 时
Worker 禁止沿用旧 Provider checkpoint。Rust focused 1/1、TS 4/4。该证据不包含 compaction/resume/fork。

Tool Approval focused evidence 同时覆盖 InMemory 与 SQLite：require 时 Approval、`run.approval.required`、Outbox 和原
Work Item 长持有原子提交；decide 时 Approval、`run.resumed` 与同一 Work Item 即时唤醒原子提交，重新 claim 的 lease epoch
从 1 推进到 2。Worker approve path 在 dispatch 前保持 Provider 0 次调用，批准后只调用 1 次并将旧 Tool Attempt 标记
`abandoned`；reject path 始终为 0 次 Provider 调用并终结 Run。真实 loopback Control API 进一步验证查询/决定和公开字段脱敏。
无人决定的 Approval 到 deadline 后进入 `expired`；等待中取消进入 `superseded`，批准后尚未 dispatch 的 cancel race 仍由
cancel 获胜。三条路径都验证 Provider 为 0 次调用。Tool Provider command 还必须携带绑定 action digest 与 policy snapshot
的 Approval proof，绕过 Worker 直接调用 per-action Broker 会 fail closed。

跨 Action 主动 replacement 的内部 authority 已落到 Application-owned Store Port 与 InMemory/SQLite/PostgreSQL adapter：只有
tenant/space/run/Work Item、当前 Run revision、旧 approval revision/action digest 和新 receipt/action digest 全部匹配，才能在
一个事务中 supersede 旧 approval、追加 resumed + required Event/Outbox、安装新 approval 并重新 hold 原 Work Item。稳定输入和
Application action lookup 都支持 receipt-first crash replay；stale decision/lease/replacement fail closed，Outbox 冲突会全量回滚。
生产 Runtime Worker 的 recovery/adoption 路径已接到该 authority：等待中的 Worker 只接受同一 Run/Work Item 已持久化的 `prepared`
receipt 作为候选 identity，按 canonical action digest 排除相同 Action，并在任何 Provider/Device dispatch 前调用 Application-owned
replacement transaction；稳定重试先按 replacement Action receipt 回放。当前顺序 Worker 主路径不会在旧 approval required 后主动准备
下一 Action，且仍未公开 Control API；因此本切片只声明已有跨 Action durable state 的恢复可达，不声明外部主动 replacement 已可达。

MCP focused evidence 使用官方 MIT TypeScript SDK 1.26.0 启动真实独立 stdio child process，完成 initialize、分页目录、
Tool call、结构化结果与有序关闭；production transitive license Gate 覆盖 MIT/BSD/ISC。配置解析拒绝 authority 注入和非显式
环境，目录只暴露可信配置中声明的只读 Tool。通用 MCP mutation 因无标准 durable receipt/reconcile 被构造期拒绝。

Device Gateway focused evidence 使用真实 loopback WebSocket 覆盖 Hello、command、逐序 ACK、terminal receipt、lease-fenced
cancel、stale lease fail closed 与断线后的 stable-receipt `unknownOutcome`。Gateway 将 Hello 绑定到独立认证身份，并提供 TLS 1.3
和 mandatory client certificate 的 WSS entrypoint；mTLS verifier 仅接受 TLS 已授权、证书有效且 SHA-256 fingerprint 存在于严格
唯一 registry 的 Device。dispatch service 会按 stable execution identity single-flight，续租请求不重发、identity 漂移拒绝、
Worker request 丢失不取消 Device，cancel/reconcile 复用同一 promise；SQLite 在任何 send 前写入 prepared authority，并持久化
terminal。真实 TLS 1.3 测试证书链覆盖 mTLS Worker HTTPS→Gateway→mTLS Device WSS→terminal→Gateway 关闭重开→无 Device
reconcile replay；active recovery 用例进一步在 accepted 后断开并关闭 Gateway，以同一 SQLite 重启后只接受明确携带
`lastAcknowledged` 的 Device，发送原 durable command，Device attach 后从 sequence 1 replay，副作用启动计数保持 1；完成与取消
终态再次重启后仍可 replay。完整 RuntimeWorker 用例经过 durable per-action Approval、数据库租约、signed command、网络断线、
Run `reconciling`、Device 恢复和 follow-up model ToolResult 后完成。取消竞态验证 unknown 不能提前变成 canceled。
`ws` 固定 8.21.1 且 MIT license Gate 通过。当前证据仍不包含生产 CA/证书部署、原授权过期后的恢复或 native Device 执行。

Device Gateway Team authority 进一步使用 MIT `pg` 8.22.0 和 PostgreSQL schema v2：两个独立 Pool 并发 prepare 同一 execution
严格形成 `created + existing`，两个 Gateway service 只有一个进入 Device send；并发不同 terminal 只有一个成功，高版本 schema
在 listener bind 前 fail closed。连接 route
按数据库时间租约并原子增加 epoch，旧 epoch renew/release 失败，显式推进 expiry 后不能复活。两个真实 WebSocket Gateway
使用共享 route authority 验证新连接接管后，旧 Gateway 在下一 heartbeat 主动关闭且不能删除新 route。production Team
entrypoint 使用独立 Gateway mTLS identity、静态 HTTPS endpoint 和 strict bounded single-hop contract；目标 Gateway 核对 payload
source identity 并在 Device dispatch 前重读完整 fence。真实 TLS 1.3/mTLS 测试已覆盖 Worker→non-owner Gateway→owner
Gateway→WebSocket Device，隔离 PostgreSQL 15 下两个独立 Pool 的同一路径也通过；伪造 source identity 与 stale epoch 均在
dispatch 前拒绝。进一步的本机故障注入启动两个独立 Gateway OS 子进程：owner 在 Device `execution.accepted` 已 ACK 后被
`SIGKILL`，显式推进数据库 route expiry 后由另一进程 claim 新 epoch；reconcile 和 cancel 都 attach 原 execution，副作用启动计数
保持 1。该用例连续运行 3 次均通过且无遗留子进程。它仍使用 test identity、fake Gateway command authorizer、WebSocket Device
simulator 和确定性 SQL expiry；完整边界见 `artifacts/migration/device-gateway-ha.md`。

Device wire conformance 不再是两份手写样例：TS strict parser 与窄边界 Rust `crewon-device-protocol` 同时消费
`device-protocol.reference.json`，覆盖 signed command、Hello、Gateway welcome/connection epoch、ACK、cancel、六类 execution
event、八个拒绝错误码和 canonical signing payload SHA-256。Gateway 在共享 route claim 后、Session 可 dispatch 前发送 welcome；
网络 Device simulator 在收到 welcome 前不接受 command。Gateway 使用注册的 Ed25519 public key 验签并在发送 Device 前拒绝篡改；
Rust 使用同一 canonical payload 和 `ed25519-dalek` 验证签名及签名后的 lease mutation。Cargo focused
test `1/1`、Cargo/Bazel lock update/check 通过；Bazel unit-test target 与 fixture runfiles label 可解析，但本机实际 Bazel test 在
analysis 阶段下载 Apple CLTools SDK 时收到上游 `403 Forbidden`，没有进入新 crate 编译，因此不能称 Bazel test 已通过。

最小 Rust `crewon-device` crate 当前只依赖 Device Protocol、Ed25519、时间与序列化，不依赖 CrewON domain、Store、Provider、MCP
或 UI。
connection epoch 使用私有目录中的 append-only 原子 record：新 epoch 文件完成 `fsync` 后才更新内存；重启拒绝相同/更低 epoch，
过期 welcome、错 Device、损坏持久状态均 fail closed。Capability dispatcher 在不可逆副作用开始前必须持有
`ConnectionEpochPermit`，从而与新 welcome 线性化。初始 route lease 只在接受 welcome 时校验，避免数据库 heartbeat 续租后
Native 因最初 30 秒 expiry 误停。`NativeDeviceConnection` 进一步在原始 frame byte cap 后做 shared strict parse、轮换 PEM key
lookup、Ed25519 signature/expiry 验证，并在最终 start 点重复时间校验后才拿 permit；takeover 发生在 verify/start 之间时副作用为 0。
Cargo focused `10/10` 通过；Bazel 新 target 可 query，但同样被 Apple CLTools
SDK `403 Forbidden` 阻断在 analysis，未进入编译。

`workspace.read_file.v0` durable foundation 已独立于 `workspaceList` 落地：strict accepted/terminal/unknown-outcome event 与 cumulative
ACK 绑定 execution、workspace incarnation、connection epoch、sequence 和 command digest；completed UTF-8 content 复算 SHA-256，
时间与 exact keys 均 fail closed。Native SQLite journal 使用独立 read execution/event/ACK 表，accepted 在 side effect 前提交，
terminal/ACK 可跨重启 replay，command、terminal 或 ACK identity drift 均拒绝。该 capability 仍未进入 Device Hello、Native runtime
router、Gateway admission 或 Worker 产品路由；下一阶段仍是 ConnectionEpochPermit 下获取 stable file handles、释放 permit 后 blocking
read、完成前复核 expiry/epoch/incarnation，并用 deterministic takeover barrier 证明旧 epoch 不产生成功 terminal。

首次无法证明的 Tool 结果不再经过三次独立提交：Receipt `unknownOutcome`、`run.reconciliation.required`、Outbox、当前 Tool
Attempt 的 retryable failure 与原 Work Item retry release 已收敛为同一 fenced InMemory/SQLite transaction。双 Store
conformance 同时验证成功状态和强制 Outbox 冲突时全量回滚；Worker 集成路径验证进入 reconciliation 前的 Attempt 已终结为
`tool_outcome_unknown`，不会留下一个伪 running Attempt。

最近一次 Rust `crewon-core` 全量基线快照为 2738 tests：2733 passed，另有 1 个 flaky retry 后通过，4 failed、1 timed out；
本轮 focused discovery 已显示当前代码树共有 2753 tests，但没有重新外推全量结果。
非绿项分别位于已有 config schema drift、image preparation timeout、remote compact base instructions、subagent notification
与 rmcp image response；本批新增的 AR-002/003/008/009/010/021/022 focused tests 全部通过。该结果不外推为 Rust workspace 全绿。
Bazel 已能解析 11 份 shared fixture label；进一步 `somepath` 图验证被当前外部 lock 中 openssl-src 版本漂移阻断，本批没有
修改 Rust dependency 或 lockfile。

Checkpoint/cancel 另有以下无 sleep 证据：两个独立 SQLite connection 中 Control 侧提交 cancel 后，Watcher 主动 abort
静默 Provider body；首次 Direct Run 将 `resp-first` 与 assistant Message 原子提交，关闭并重开 SQLite 后，第二个 Run 只
发送新增用户消息并使用 `previous_response_id=resp-first`，随后推进到 `resp-second`。Trigger 强制 terminal Message 失败时，
`resp-rolled-back` 不会写入 continuation；修复后不同的 `resp-committed` 可重放成功，不产生 idempotency conflict。

Dispatcher focused test 模拟 Runtime Worker 绕过 Control API、直接向同一 Store 提交 `run.started` Event + Outbox；
Control API dispatcher 随后领取该消息并将 committed Event 推入 live hub 后 ack。Malformed Outbox 会 durable retry，
不会形成进程内 busy loop。

冻结锁文件安装后，CrewON UI TypeScript lint 与 production build 均通过。完整 UI 测试为 `1695 passed / 1 failed`；
唯一失败是当前共享 dirty worktree 中 `original-shell-overrides.css` 的 workbench tab shrink 改动尚未更新
`CommandWorkspaceConversationStyle` snapshot，与本批 Control API/类型边界无关，本批未擅自接受该视觉快照。

本迁移切片 owned paths 的 Prettier 检查通过。仓库根 `pnpm run format` 仍因共享工作区已有的
`docs/ARCHITECTURE.md` 与 `docs/wecom-sso.md` 格式差异失败；本批未越界重写这两份文档。

`packages/artifacts` 已建立 Standalone Artifact v0 authority：严格 Tool-output record 绑定 tenant/space/owner 与
run/step/attempt/call provenance、SHA-256、size、retention、AES-256-GCM key ID 和 scan state；SQLite 保存 immutable metadata 与
`writing -> ready` 状态，密文文件使用原子 rename。重启可恢复“blob 已提交、metadata 未 finalize”的窗口，同幂等键内容漂移、跨租户读取、
密文/认证标签篡改和宽松 key-file 权限全部 fail closed。Runtime Worker 在 40KB 截断前自动持久化完整 raw output；外部
`artifactRef` 必须匹配 exact provenance 与内容 digest/size。Control API 提供授权 metadata/content，公开 DTO 不含 scope、owner、
attempt、key ID、scanner 或底层路径；`@crewon/control-client` 下载时有 1MiB hard cap 并复核 ETag SHA-256。真实 loopback E2E 已覆盖
HTTP 创建 Run -> Worker 大 Tool 输出 -> 加密落盘 -> HTTP 读回完整原文，并证明 blob 不含明文。

## 尚未完成，禁止外推

- `ActionIntent v0` 与 Device WSS v0 的 TS types、JSON Schema、strict parser、TS/Rust shared fixture、Gateway 会话和 strict
  mTLS WSS entrypoint、signed command wire/canonicalization、TS/Rust Ed25519 verification、Worker-side Device Tool mapping、
  authenticated Worker→Gateway API、单 Gateway SQLite terminal replay、原授权有效期内的 active reconnect、PostgreSQL shared
  execution/route authority、Gateway peer mTLS forwarding、connection-epoch welcome wire、Native raw Ed25519/epoch admission 与开源
  Ed25519 private-key signer 已落地；前一协议版本兼容、Kotlin/Swift generated client、动态注册/轮换、HSM/KMS signer、长断线
  授权续期、Native WSS/UDS dispatcher/capability/receipt 接线、完整 Native Runtime 和真实三平台 transport 尚未落地。
- Thread/Message 的 create/get/append/list、model round、fork lineage/history copy、archive/unarchive/rename/terminal soft-delete
  CAS/receipt/durable event SSE 与 Tool Step/Attempt authority 已落地。Delete 与 Goal CAS、Goal snapshot clear、`goal.cleared`
  同事务提交；非终态 Run/WorkItem 会拒绝删除，标准读取隐藏 tombstone，audit 由独立权限恢复历史。Agent/Workflow
  Node/Gate/Verification 多 Step 编排尚未接入；Thread review 与 legacy 批量迁移命令仍未完成。
  Artifact v0 当前只覆盖 Standalone Tool text output；Team/Cloud S3-compatible object authority、external KMS/HSM、key rotation、
  malware scanner、versioned backup/restore 和大于 1MiB 的 streaming upload 尚未完成。独立 Tool Approval 的
  required/approved/rejected/expired/superseded domain 已落地，当前生产链路
  已接 required/approved/rejected/expired，deadline 到达后由重新 claim 的 Worker 原子恢复 Run 并 fail closed；跨 Action
  replacement authority 与生产 Worker recovery/adoption caller 已接线；顺序主路径不会自行制造 replacement 候选，公开 Control API 也仍未接线。
- PostgreSQL queue、Thread/Message/Model History、Run、Step/Attempt、text/tool/approval 组合事务已组成完整
  `PostgresDomainStore`，并通过数据库时间、双 Pool `SKIP LOCKED`、完整 Store/Worker conformance 与跨进程竞争/SIGKILL 恢复；
  LISTEN/NOTIFY、备份恢复、跨主机网络分区、staging chaos 与 production SLO 尚未落地。
- 旧 JSONL 的 import-only compiler、source digest、原子 SQLite commit/replay 已落地；批量 discovery/dry-run report、
  legacy SQLite importer、可查询 provenance manifest 和 Authority cutover 尚未落地。
- Runtime Worker、owned Kernel、deterministic fake、Direct Responses HTTP/SSE 与可选 WebSocket/sticky HTTP fallback 已接入；
  server-selected multi-version backend vertical slice 已通过 SQLite 与 typed Control client；live OpenAI account、Device Tool
  Adapter/native execution 和真实 CrewON UI/SSE 纵向闭环仍未接入。
- durable Tool Step/Attempt/Receipt、Worker-owned execute/reconcile 与完成组合事务已落地；`InMemoryToolBroker` 仅是
  deterministic Provider adapter，其 process-local Provider receipt cache 不是生产 authority，生产默认不发布任何 Tool
  definition。ActionIntent 与 per-action Approval 已接 Worker/Store/Control API，批准前和拒绝后 Provider 均不会被调用；
  shell/MCP mutation/Device 等副作用 Tool 仍必须等 Team-grade Artifact/KMS、durable remote receipt 与真实 reconciliation
  Adapter 完成后才能全面启用；Gateway 间 mTLS 单跳与双进程 `SIGKILL` reconcile/cancel 已有本机共享 PostgreSQL 证据，但尚未
  接真实 Native sidecar 和 production chaos，因此没有完整生产 HA；
  stdio MCP read-only 主路径已经接入真实独立进程。
  Tool round 中 completed assistant text + Tool call 的 manual/stored `end_turn=false` 主路径已接入 durable continuation；只有
  partial delta 缺少 completed assistant item 时继续 fail closed。aborted Tool call/output/marker 已进入 SQLite Model History，
  并在关闭重开后的下一 Run 请求中通过 shared Rust/TS fixture。
- transport 收到 AbortSignal 后会主动终止 blocked fetch/body；SQLite durable cancel watcher 已落地，但仍是 bounded
  polling，不代表 PostgreSQL LISTEN/NOTIFY、跨节点低延迟或进程级强杀均已验收。
- `previous_response_id` 已通过 atomic Thread continuation 跨 SQLite 重开；显式 Run Step/Attempt history、attempt lease
  transition 与中途 response retrieve/reconcile 已落地。`response.created` checkpoint 先以当前 lease/epoch fence 原子写入
  Attempt；同进程 stream 中断改为 GET 同一 response，crash reclaim 从 abandoned Attempt retrieve，绝不重新 POST sampling。
  pending 保持可恢复，只有严格验证的 completed/failed/incomplete terminal 才推进 Run；不支持 retrieve 的 Provider fail closed。
  共享 fixture 明确 Rust source pointer 只冻结 retry/incomplete safety，Rust 当前没有对应的跨进程 durable retrieve authority。
- 当前 Agent trace 覆盖 text-only、AR-002 early/partial-close retry、AR-003 error release、AR-004–006 WebSocket fallback/sticky/visibility、
  AR-007 Responses Lite、AR-008 usage limit、AR-009 content filter、AR-010/011 canonical/incremental history 与 AR-013–022
  Tool 主路径、AR-023–025 compaction、AR-026/027 legacy resume/fork 与 AR-030 policy failure；AR-012/029 也已完成 shared
  fixture。AR-001 新增完整 shared Turn trace：Rust 真实 Turn 与 Worker 的 InMemory、SQLite、PostgreSQL 路径共同差分 request、
  event、history、usage、active slot release 与 terminal state；同一 Turn 二次 sampling 复用由 AR-013 shared Tool round 交叉证明。
  AR-018 reviewed read-only MCP 已由 shared scheduling fixture、真实 stdio 进程和 durable Worker 并发/有序提交证明；AR-017/019
  已冻结为 intentional redesign：未审计 Tool 不暴露，server opt-in 不能绕过 effect/recovery policy，stdio mutation MCP 在没有
  durable provider receipt/reconcile 前保持 unavailable。Approval 主路径有本地双 Store + Worker + HTTP 证据。
- 当前测试证明本机 Node 24、SQLite 与隔离 PostgreSQL 15 完整 DomainStore、Worker conformance、进程级竞争和 SIGKILL
  recovery；不证明跨主机网络分区、备份恢复、staging、生产、三平台或用户可见功能等价。

## 下一顺序

1. CrewON UI 的 Thread/Turn/Run/Goal production composition 已支持单一 `ControlThreadRuntime`：同一个认证 client 承担 JSON、Run SSE
   与 Goal SSE，snapshot/eventSequence handoff、切线程 generation fence、unknown-outcome 同 key 重试和 clear 后新 Goal revision 1
   均已进入 deterministic tests。Goal/Plan 发送已删除旧 set/clear 预写，只通过原子 `startTurn.executionIntent`；可见 intent 只在
   Turn 成功后 compare-and-clear，旧 Goal RPC/WS notification 不再参与新 authority。macOS arm64 packaged PC 已用官方 Node 24
   sidecar 实包验证受监督 Control API/release/Worker、memory-only IPC session、ready Gate、兄弟进程强杀与无 orphan；Web 已有独立
   Node BFF、双凭证边界、production Identity/Policy composition 与 source Gate。Provider credential 已由开源 `keyring` adapter
   绑定 OS secret store，renderer 只访问非敏感 catalog；切换时先用 SQLite admission fence 阻断新 Run，再同时替换 Control/Worker，
   候选失败恢复旧 release/runtime，补偿失败则 fail-closed shutdown。下一步是 Windows/NSIS 实包、签名/updater、真实 Provider canary、
   真实 Identity/PIM 双租户 staging，以及按 `legacy-app-server-cutover.md` 逐能力删除包内旧 app-server；当前不把
   单平台本机实包和 deterministic identity contract 外推为三平台或 production cutover。
2. 将已落地的 `crewon-device` raw authorization/epoch admission 接入真实 WSS/UDS capability dispatcher、durable receipt 与
   process/PTY/filesystem primitives。随后接 HSM/KMS signer、Approval 跨 Action supersede，并把 Standalone Artifact 扩展为 Team
   S3-compatible + external KMS authority；完成三平台 security gates。Gateway peer mTLS 单跳、双进程 owner `SIGKILL`
   reconcile/cancel、Native focused `10/10`、单 Gateway SQLite terminal restart replay 与 Standalone Artifact E2E 已通过。
3. default/selected-version 的 Control admission 与 Worker runtime binding 已收敛到 atomic durable release bundle；外部 release/
   rollback compiler 已从 Worker 抽离并带专用授权、operator audit、activation replay 与 CAS pointer。下一步进入 staging canary、
   跨主机故障/备份恢复验证；远程 mutation MCP 仍需另行完成 auth + durable receipt/reconcile。
4. 扩展 Tool/Agent/Workflow Node/Gate/Verification 多 Step 编排，并补 Human Gate 与 Artifact retention/scan lifecycle。
5. Thread unarchive/rename/terminal soft-delete 已完成；下一步只在建立独立审计/交付语义后开放 review，并为 PostgreSQL 增加
   LISTEN/NOTIFY、备份恢复、跨主机故障注入和 staging SLO 证据。
