# CrewON 全面迁移重构计划

状态：Execution Plan v1  
日期：2026-08-08  
目标架构：[ARCHITECTURE_FINAL.md](./ARCHITECTURE_FINAL.md)  
模块清单：[artifacts/migration/module-disposition.md](./artifacts/migration/module-disposition.md)

本文把最终态拆成可实施、可验收、可回滚的迁移序列。它不表示迁移已经开始上线，也不把局部 PoC、mock、
focused test 或双栈运行当作完成。

## 2026-08-14 执行方式覆盖：pure TypeScript breaking cutover

以下规则覆盖本文较早的 Rust parity、双栈 cohort、legacy importer 与兼容观察期要求：

- Agent Runtime、Workflow、Workspace、Control、Store 与产品 API 只继续落在 TypeScript；不再实现 Rust App Server、
  Device、Gateway 或业务 Runtime 的兼容、回退、双写和行为对齐。Rust 只保留 Tauri 桌面壳与无业务语义的进程 guardian。
- 当前迁移期间不会使用 legacy Workflow/Office/PIM 运行路径或旧数据；直接删除其 production 入口，不实现 importer、
  dual-read、shadow execution 或同一 Run 的 cohort routing。若未来确认存在必须保留的生产数据，再以独立数据迁移任务处理。
- 不因取消兼容而降低新 authority 的正确性 Gate：事务原子性、receipt-first 幂等、lease/epoch fencing、unknown outcome、
  cancel/reconcile、tenant/space/secret 边界与 crash recovery 仍必须通过 SQLite/PostgreSQL 和 packaged 纵向验收。
- 迁移进度只按当前 TypeScript production graph 与真实行为证据判断；仓库中未进入 build/runtime graph 的历史 Rust 文件
  不是当前 cutover blocker，也不能成为重新接入 fallback 的理由。
- updater 签名/notarization 与 Windows installer/guardian canary 是发布凭据和平台验证 Gate，和业务 Runtime 兼容分开管理。

## 1. 最终结果与迁移边界

迁移完成后：

- Agent、Thread、Workflow、Office、Automation、Provider、Memory、配置、API 和 Store 的产品语义全部由
  TypeScript 拥有。
- CrewON 自有 TypeScript Agent Kernel 是默认 Agent loop；Direct Responses Adapter 是默认模型传输。
- `@openai/agents` 是可关闭的可选 Adapter，不是 session、tool、approval、handoff、trace 或数据权威。
- PC 保留 Tauri + React；Rust 只保留最小 Tauri shell 和无产品领域的进程 guardian。
- PC、Web、Mobile 只访问版本化 Control API/SSE；UI 不再直连 Agent Platform 或 Provider execution path。
- Standalone 使用 SQLite 唯一写 Authority；Team/Cloud 使用 PostgreSQL 唯一写 Authority。
- Single、Workflow、Office、Experts、Automation 共用 Run/Step/Attempt/Event/Approval 模型。
- 旧 Rust 业务运行时、旧 JSON-RPC 业务协议、双 scheduler、fallback 和重复 authority 从发行物移除。

不在迁移中做的事：

- 不做 Rust 到 TypeScript 的语法级自动转译。
- 不把当前所有兼容逻辑、历史类型和已删除能力原样复制进新内核。
- 不在一次发布中同时切换 Agent、Store、API、Desktop 和全部 Workflow。
- 不长期双写，不在新路径失败时静默回退旧写路径。
- 不把 Node/Electron/Agents SDK/微服务数量本身当作重构目标。

## 2. 当前基线与为什么不能大爆炸重写

本计划基于 2026-08-08 当前 checkout 的只读盘点；工作树处于大型迁移中，数字只作为范围证据，不是稳定版本
承诺：

- `codex-rs/core/src/session/turn.rs` 约 2,316 行，拥有 Agent turn 主循环和工具推进语义。
- `codex-rs/core/src/client.rs` 约 2,289 行，直接实现 Responses HTTP/WebSocket、续接、prewarm、fallback 和错误处理。
- `codex-rs/app-server/src/message_processor.rs` 约 5,589 行，集中大量 RPC dispatch 和跨领域协调。
- `thread_processor.rs` 约 5,568 行，`crewon_domain_office_run.rs` 约 8,009 行，
  `crewon_domain_processor.rs` 约 4,065 行。
- 八组低层 execution/sandbox crate 合计超过 63K 行 Rust；不能未经逐项审计就声称 Node 重写行为等价。
- 当前自定义 Tauri shell 只有 152 行 Rust；为消除这部分 Rust 改成 Electron，不是最佳收益路径。
- 当前依赖清单中未发现官方 `@openai/agents`；现有 Agent 是 CrewON/Codex Rust 自有 harness，直接使用
  Responses-compatible 协议。

因此迁移对象不是“一个 Rust 后端”，而是至少六个互相耦合的系统：Agent Kernel、模型传输、产品控制面、
durable execution、设备执行和客户端协议。必须按 authority 与副作用边界切换。

## 3. 迁移的六种处置方式

每个现有模块和行为在动工前必须标记一种主处置方式；未归类代码不得迁移或删除。

| 类型            | 含义                                                         | 典型对象                              |
| --------------- | ------------------------------------------------------------ | ------------------------------------- |
| `PORT_EXACT`    | 保持外部行为和不变量，用 TS 重新表达                         | reducer、校验、预算、事件映射         |
| `PORT_REDESIGN` | 保持契约和结果，重做并发、恢复、持久化或边界                 | Agent loop、stream、scheduler         |
| `KEEP_NATIVE`   | 只保留平台原语并从产品领域依赖中剥离                         | process、PTY、patch、sandbox          |
| `GENERATE`      | 以 OpenAPI/JSON Schema 为 source of truth 生成               | REST DTO、SSE event、Device Protocol  |
| `IMPORT_ONLY`   | 只用于一次性/按需迁移，不能进入正常新运行路径                | rollout/Office legacy importer        |
| `DELETE`        | 无产品价值、重复 authority、旧 fallback 或不支持能力直接删除 | v1、UI direct execution、双 scheduler |

“逐行迁移”的正确含义是逐项行为可追踪：每个 Rust 行为必须能映射到 `PORT_*`、`KEEP_NATIVE`、`IMPORT_ONLY` 或
`DELETE` 的清单项和证据；不要求 TypeScript 与 Rust 具有相同行号、函数结构或并发实现。

## 4. 不可违反的迁移规则

1. **一份写 Authority**：同一个 Aggregate 同一时刻只有旧或新一方写；禁止长期 dual write。
2. **Run 创建时固定路线**：`runtimeGeneration`、authority、AgentVersion、execution target 创建后不可切换。
3. **副作用不 shadow execute**：Shell、文件、Git、MCP mutation、外部 API mutation 不允许双跑比较。
4. **旧行为先固化再改写**：先生成 fixture/trace，再写 TS；不能以新实现输出定义旧行为。
5. **协议先于实现**：REST/SSE/Device schema 先冻结，服务端和客户端从 schema 生成。
6. **未知结果 fail closed**：设备断连或进程崩溃后的 mutation 进入 `unknownOutcome` + reconcile，不自动重试。
7. **没有 silent fallback**：新路径失败就是新路径失败；只能由明确 cohort/run route 选择旧或新。
8. **数据迁移可重复验证**：importer 幂等、可 dry-run、输出 count/digest/provenance，不改写原始数据。
9. **客户端不做权威判断**：terminal、approval、retry、cancel 和恢复状态只来自 Control Plane durable record。
10. **证据分层报告**：unit/fixture/mock/SQLite/单进程通过不能外推为 PostgreSQL、多 Worker、三平台或生产通过。

## 5. 工作流分解

### WS0：行为考古与兼容基线

负责把现有 Rust 变成可执行规范，而不是靠人工记忆迁移。

交付：

- P0/P1/P2 行为目录，记录入口、前置条件、输出、事件顺序、错误、持久化和副作用。
- 从现有 integration tests 提取 deterministic model/tool/provider fixtures。
- Rust reference harness：输入 fixture，输出脱敏 canonical request/event/state trace。
- TS candidate harness：消费同一 fixture，输出相同 canonical trace。
- 差分工具只比较稳定语义，过滤 timestamp、requestId、traceId 等显式 nondeterministic 字段。
- 删除候选必须记录调用方、usage evidence、替代能力和观察期。

退出条件：所有 P0 主链路都有 owner、处置方式、fixture 和可自动比较的期望；未覆盖项不能进入 cutover。

### WS1：Contracts、Domain 与 Store Foundation

当前落地证据和未完成边界记录在 `artifacts/migration/ws1-implementation-status.md`；并行 worktree 的隔离成果、冲突和强制合并顺序记录在
`artifacts/migration/parallel-worktree-integration.md`。这些状态文件不替代本节退出条件，隔离 worktree 的测试也不等于 shared root 已集成。

交付：

- `packages/contracts`：OpenAPI 3.1、SSE event schema、Device Protocol schema 和 generated clients。
- `packages/domain`：Thread、Run、Step、Attempt、Approval、Event、Artifact 的纯状态机。
- `packages/application`：command/query、authorization、idempotency 和 transaction boundary。
- `packages/store`：SQLite/PostgreSQL conformance adapters、outbox、lease、snapshot、event sequence。
- schema compatibility、migration graph、dependency boundary 和 circular import CI gates。

退出条件：SQLite/PostgreSQL 对同一 contract suite 结果一致；reducer property tests、outbox/lease crash tests 通过。

### WS2：CrewON Agent Kernel 与 Model Transport

交付：

- 自有 TS Kernel 的 bounded segment 状态机，不在一个内存循环里隐藏 durable transition。
- Direct Responses HTTP/WebSocket Adapter；迁移 stream parsing、`previous_response_id`、routing、prewarm、fallback、
  idle timeout、usage 和错误分类。
- bounded context assembler、compaction、cache-friendly incremental history、token hard cap 和 provenance。
- deterministic fake model 和 self-hosted OpenAI-compatible smoke Adapter。
- 可选 `@openai/agents` Adapter；只在同一 conformance suite 通过后可用于显式 AgentVersion。

退出条件：P0 text/tool/cancel/resume/request-body/event-trace 与 Rust reference 等价；默认路径不安装 Agents SDK 也通过。

### WS3：Tool、MCP、Policy、Approval 与 Native Runtime

交付：

- Tool Registry/Broker：schema validation、capability、ActionIntent、Action Digest、approval 和 bounded result。
- MCP server 生命周期、tool refresh、tool exposure 和 connection failure 的 TS runtime。
- 新 Device Protocol、lease/epoch/idempotency/receipt/reconcile/cancel。
- 从现有 crate 提取最小 `crewon-device`、process/PTY、filesystem/patch/Git 和 sandbox allowlist。
- host、Docker、remote sandbox 和 deterministic fake 均实现同一 `ExecutionProviderPort`。

退出条件：只读、写审批、参数篡改、cancel race、stale lease、replay、workspace escape、output cap 和 unknown outcome
三平台 contract tests 通过；Rust Native Runtime 无产品领域依赖。

### WS4：Workflow、Office、Experts 与 Automation

交付：

- WorkflowVersion DAG 编译为 Run/Step；Human Gate 是 durable Approval。
- 本地工作流保持 `resourceSource: crewon` 和本地 durable Agent thread，不回退 PIM/cloud execution。
- Office 定义和 UI projection 迁移到统一 Run，不再拥有专用 scheduler/reducer/store。
- Automation 只创建 Run；schedule misfire、dedupe、timezone 和 ownership 进入统一 application service。
- 迁移 waiting approval、cancel best-effort interrupt、recovery 和 receipt invariants。

退出条件：Single/Workflow/Office/Experts/Automation 全部只产生统一 Run；旧 scheduler 和 legacy mutation 路径无调用。

### WS5：Control API、Identity、Provider 与客户端

交付：

- Fastify Control API 的 REST/BFF/SSE；`Last-Event-ID` 从 durable event sequence 续读。
- OIDC/standalone identity、tenant/space/actor/credential owner 在服务端解析。
- PIM 只提供资源、entitlement 和 billing；不能成为 Workflow/Agent execution authority。
- React 从 generated client 访问 Control API；删除旧 JSON-RPC capability probing 和 UI direct provider path。
- Tauri 只保留窗口、更新、deep link、sidecar lifecycle 和最小 typed IPC。

退出条件：PC/Web/Mobile contract tests 使用同一 schema；DOM 无 secret/provider internals/绝对路径；旧 client 无调用。

### WS6：迁移、发布、运维与旧系统退休

交付：

- legacy snapshot/export/import/verify 工具和逐 authority cutover runbook。
- cohort routing、release manifest、protocol compatibility、SBOM、签名和回滚矩阵。
- OpenTelemetry、metrics、audit、redaction、SLO、backup/restore 和 incident drill。
- 旧 Rust business binary、RPC、schema、fallback、scripts 和 dependencies 删除。

退出条件：新 authority 独立运行完整观察期；旧系统停机后无 fallback；恢复、升级和 rollback drill 有真实证据。

## 6. 分波实施计划

每一波只能在前置 Gate 通过后扩大范围。时间是 6–8 名有经验工程师的粗略工程量，不是发布日期承诺；多条
workstream 可并行，但 authority cutover 是串行关键路径。

| 波次 | 预计    | 范围                                                      | 退出 Gate                                              |
| ---- | ------- | --------------------------------------------------------- | ------------------------------------------------------ |
| 0    | 2–3 周  | 冻结 P0 行为目录、reference harness、模块处置、指标基线   | P0 可差分；删除项有证据；无未归类 cutover 项           |
| 1    | 4–6 周  | contracts/domain/store skeleton、fake model、API/SSE 骨架 | 双 Store conformance；restart/SSE resume；无业务副作用 |
| 2    | 5–8 周  | 新建 Thread → text Run → stream → persist → reconnect     | Direct Responses 等价；restart 恢复；小范围内部 cohort |
| 3    | 8–12 周 | read-only tool → approval mutation → Device Runtime       | digest/receipt/reconcile/cancel/三平台 security gates  |
| 4    | 6–10 周 | context、MCP、provider、artifact、memory                  | P0 Agent parity；self-host path；上下文 hard cap       |
| 5    | 8–12 周 | Workflow、Human Gate、Automation                          | durable DAG、重启恢复、无第二 scheduler                |
| 6    | 8–12 周 | Office/Experts 统一 Run；客户端 generated API             | Office parity；UI direct path 清零                     |
| 7    | 6–10 周 | authority 数据迁移、Standalone/Team canary                | digest/count/invariant 全过；无双写；rollback drill    |
| 8    | 4–8 周  | 默认切换、观察、删除旧 Rust 业务 runtime                  | 旧进程停机观察期；无 fallback；发布与恢复 Gate         |

总历时预估：

- 6–8 人稳定团队：约 9–15 个月。
- 4 人团队：约 14–22 个月，并应缩小并行 workstream，不能删减 Gate。
- 第一条可用新纵向切片：约 6–10 周；它只证明迁移机制，不代表完整产品完成。

影响时间最大的不是 TS 代码量，而是 P0 行为识别、三平台 execution parity、在途数据、Office/Workflow 统一和真实
canary 观察。若跳过这些工作，日历时间会缩短，但重构后使用效果无法保证。

## 7. 第一条纵向切片

第一条切片固定为：

```text
现有 React UI
  -> generated Control API client
  -> create Thread and text-only Run
  -> TypeScript Worker
  -> CrewON Agent Kernel
  -> deterministic fake / Direct Responses Adapter
  -> persist snapshot + event + outbox
  -> SSE stream and Last-Event-ID reconnect
```

包含：新 contracts、Run reducer、SQLite/PostgreSQL store conformance、text delta、usage、cancel、restart recovery、
SSE resume、trace diff 和 feature cohort。

明确不包含：Tool、MCP、文件、Shell、Workflow、Office、生产数据迁移和旧系统删除。第一切片不允许调用 Rust Agent
fallback；cohort 在 Run 创建前选择旧或新路径，Run 内不能切换。

通过标准：

- 同一 fixture 的模型 request、canonical events、terminal state、usage 和错误分类与 Rust reference 等价。
- SSE 在事件间任意断开后无丢失、无不可解释重复，UI projection 一致。
- Worker 在 model call 前后、event commit 前后崩溃后能恢复到确定状态。
- 新路径关闭时旧路径行为完全不变；新路径失败只影响新 cohort，不触发旧写 fallback。

## 8. 行为等价与测试策略

### 8.1 P0 行为矩阵

至少覆盖：

1. Responses request shape、stream event order、HTTP/WS 选择、sticky routing、prewarm 和 fallback。
2. incremental history、`previous_response_id`、compaction、context cache 和 token hard cap。
3. Tool schema、parallel/sequential policy、result ordering、tool error 和 bounded output。
4. approval request/action digest、拒绝、批准、参数变化、credential/workspace 变化。
5. cancel before model、during stream、before tool、during tool、after receipt 和 `no active turn` race。
6. retry/backoff、rate limit、idle timeout、partial stream、unknown provider error 和 budget exhaustion。
7. MCP discovery/refresh、dynamic exposure、server failure、approval 和 secret redaction。
8. Thread resume/fork/archive/delete、rollout reconstruction、usage replay 和 event projection。
9. Workflow queued/running/waitingForApproval/completed/rejected/canceled、Human Gate 和 restart recovery。
10. Office manager/member/message/run/receipt/recovery、automation binding 和 local execution authority。
11. filesystem/patch/Git/process/PTY/sandbox 三平台语义、workspace escape、output/resource cap。
12. identity、tenant/space、resource binding、provider credential owner 和 revocation。

### 8.2 差分方法

- **纯逻辑**：共享 JSON fixture，Rust 与 TS 输出 deep-equal canonical object。
- **Agent loop**：fake model 按脚本发事件；比较 outbound request 和完整 canonical event trace。
- **持久化**：比较 command 后 aggregate snapshot、event、outbox 和 receipt，不比较内部表布局。
- **只读外部调用**：可对相同 snapshot 做 shadow query，但结果不得写回产品状态。
- **副作用调用**：Rust 只生成脱敏 `ActionIntent`，TS 与其比较 digest；真实副作用只执行一次。
- **live provider**：使用 eval 统计非劣化，不要求自然语言逐 token 相等；协议与状态仍必须确定性一致。

### 8.3 发布质量阈值

在每个扩量 Gate 前至少满足：

- P0 deterministic trace：100% 通过；P1 不低于约定基线且无未解释回归。
- 数据：0 丢失、0 跨租户、0 重复已知副作用、0 silent fallback。
- 安全：workspace/tenant escape、secret DOM/log/context 泄漏为 0。
- 可靠性：crash/reconnect/replay 测试无悬挂 non-terminal Run。
- 性能：text first-event p95、Tool dispatch p95、SSE catch-up、内存和安装包大小不劣化超过批准预算。
- live eval：任务完成率、安全拒绝率、Tool 成功率和人工接管率达到或优于旧路径置信区间。

具体 p95 数值在 Wave 0 从真实基线确定，不能先写一个没有测量依据的漂亮数字。

## 9. 数据迁移和 Authority 切换

### 9.1 原则

- 不迁移正在执行的 Run；它们在旧 runtime drain 到 terminal，或由用户明确取消后创建 provenance 派生 Run。
- 定义、Thread、terminal Run、Artifact metadata、Approval 和审计按稳定 ID 迁移；大正文使用 digest/reference。
- importer 不复用在线 application service 写入副作用；使用专用 migration transaction 和 provenance。
- 旧格式永不成为新写格式；旧 reader 只位于 `IMPORT_ONLY` 工具。

### 9.2 每个 Authority 的切换状态

```text
legacyActive
  -> quiescing
  -> snapshotCreated
  -> importing
  -> verifying
  -> newActive
  -> legacyReadOnly
  -> retired
```

每一步记录 source head/schema、snapshot digest、entity counts、terminal-state counts、artifact digests、importer version、
target schema、开始/完成时间和操作者。验证失败保持旧 Authority，删除失败 target import 后重试；不能进入半激活状态。

### 9.3 验证

- entity count、主外键、唯一约束、state transition 和 tenant ownership。
- transcript/event sequence 连续性、artifact/payload digest、approval/action digest。
- 随机样本 UI projection 与关键业务查询 deep comparison。
- importer 第二次运行无新增变化。
- 新系统只读 soak 后才允许创建新 Run。

## 10. Canary、回滚与故障处置

### 10.1 路由

- cohort 必须由服务端稳定规则选择，并在 Run 创建时写入 `runtimeGeneration`。
- 先 internal tenant，再 opt-in standalone，再小比例 Team，最后默认新路径。
- 只按新建 Run 扩量；已存在 Run 始终回到创建它的 runtime。
- Device Protocol 支持当前和前一版本；不支持版本 fail closed，不做 capability 猜测。

### 10.2 回滚层级

| 时点                       | 允许操作                                                |
| -------------------------- | ------------------------------------------------------- |
| 新路径尚未写 Authority     | 关闭 cohort，旧路径不受影响                             |
| 新 Run 已由新 Authority 写 | 停止创建更多新 Run；现有新 Run 由同一 runtime 完成/修复 |
| 数据已切换 newActive       | 不把新写入倒灌旧库；执行 forward repair 或恢复新库      |
| Device mutation 未确认     | 标记 unknown outcome 并 reconcile，禁止自动换旧执行器   |

“回滚”不能等同于对同一 Run 切回 Rust，否则最容易造成重复 Tool、重复文件写入和状态分叉。

### 10.3 自动停止扩量条件

- 任一跨租户、审批绕过、digest mismatch、secret 泄漏或 workspace escape。
- 任何已知副作用重复执行或无法 reconcile 的比例超过约定上限。
- terminal Run 丢失、事件 sequence 破坏、数据 digest 不一致。
- P0 success rate、cancel correctness 或 recovery 显著低于旧路径。
- 新路径依赖不可关闭的 hosted/闭源组件。

## 11. 主要风险与控制

| 风险                                   | 严重度 | 控制                                                         |
| -------------------------------------- | ------ | ------------------------------------------------------------ |
| Agent 行为表面可用但细节退化           | P0     | request/event 差分、live eval、同 cohort 对照                |
| Tool/文件副作用重复                    | P0     | idempotency、Action Digest、receipt/reconcile、禁止 shadow   |
| 历史/compaction 变化导致缓存和效果下降 | P0     | incremental context fixture、request-body diff、token budget |
| SDK 隐式语义取代 CrewON                | P0     | SDK 可选、类型隔离、默认 Direct、conformance Gate            |
| Rust 业务逻辑偷偷留在 Native Runtime   | P0     | crate allowlist、依赖图 Gate、domain import ban              |
| TS 并发/取消语义与 Tokio 不同          | P0     | explicit state machine、AbortSignal、crash/cancel schedule   |
| Store 双写或 fallback 造成分叉         | P0     | aggregate authority、route pinning、无 silent fallback       |
| Office/Workflow 统一时丢失恢复语义     | P0     | receipt/recovery fixture、先 Workflow 后 Office              |
| UI 直连 Provider 路径未清干净          | P1     | import/network CI denylist、浏览器网络审计                   |
| Rust 原生裁剪过晚阻塞三平台            | P1     | Wave 1 开始 dependency slice，Wave 3 前完成 prototype        |
| 性能/包体/内存劣化                     | P1     | Tauri 保留、基线预算、每波 benchmark                         |
| 迁移周期内双栈认知成本                 | P1     | 新功能只进新边界、owner map、明确删除 Gate                   |
| 大型脏工作树让结论或改动串线           | P1     | owned paths、独立 PR、allowlist audit、禁止 reset/clean      |
| 许可证或预编译二进制引入非开源依赖     | P1     | lockfile Gate、SBOM、source/checksum/NOTICE 扫描             |

## 12. 团队与变更组织

建议 6–8 人核心团队：

- 2 人 Agent Kernel/Responses/context/MCP。
- 2 人 domain/store/Control API/data migration。
- 1–2 人 Device Native Runtime/Tauri/三平台。
- 1–2 人 Workflow/Office/client/eval；安全、SRE 和 QA 按 Gate 参与。

代码交付规则：

- 非机械 PR 建议小于 500 行复杂逻辑，任何 PR 不应靠超过 800 行掩盖行为边界。
- 一次 PR 只建立一个新 authority 或一个 protocol slice；迁移、切流、删除分开评审。
- 新旧实现不得在同一模块中不断加 `if legacy`；compatibility 只能在明确 adapter/router。
- 每个工作流维护 owner、输入、输出、依赖、风险、测试、cutover 和 deletion issue。

## 13. 前两周启动清单

### 第 1 周

1. 冻结 ADR-007 和本计划，指定各 workstream owner。
2. 从 `core/tests/suite` 选择首批 20–30 个 P0 Agent/Responses/cancel/Tool tests，建立 fixture inventory。
3. 定义 canonical `ModelRequest`、`CanonicalAgentEvent`、`RunSnapshot`、`ActionIntent` 的 v0 schema。
4. 建立 `packages/contracts`、`packages/domain`、`packages/test-contracts` 空骨架和依赖方向 Gate。
5. 记录旧路径 first-event、success、cancel、Tool、内存、安装包和编译时间基线。
6. 对 Rust execution crates 做 symbol/callsite inventory，区分平台原语和产品语义。

### 第 2 周

1. 实现 Rust trace exporter 与 TS trace comparator，先跑 text-only 和一次 tool-call fixture。
2. 实现 Run reducer v0 和 SQLite in-memory conformance test；PostgreSQL fixture 同步定义。
3. 冻结 `POST /threads`、原子 `POST /threads/{id}/turns`、底层 Message/Run 管理端点和 `GET /runs/{id}/events`
   的首版 OpenAPI/SSE schema；正常用户输入不得由客户端拼接 Message 与 Run 两次写入。
4. 实现 deterministic fake model；禁止真实网络和 sleep。
5. 建立 cohort router contract 和 `runtimeGeneration` pinning test，但不接生产流量。
6. 提交 Native Runtime extraction RFC：精确到保留 symbol/crate、删除依赖和三平台测试，不接受整 crate 默认保留。

两周结束的唯一成功定义是“迁移工厂可运行”：同一 fixture 能在 Rust reference 和 TS skeleton 间产生可解释差分。
它不是新 Agent 已完成，也不能用于生产切流。

## 14. 最终完成定义

只有同时满足以下条件才能关闭迁移项目：

- `ARCHITECTURE_FINAL.md` 的全部完成定义通过。
- P0 行为目录 100% 有最终处置和证据，P1 遗留有显式产品决策。
- CrewON Kernel + Direct Responses 是默认生产链路；Agents SDK 完全可移除。
- Rust 中没有产品领域状态，普通产品需求不进入 Rust build graph。
- Standalone SQLite、Team PostgreSQL、多 Worker、PC/Web/Mobile 和三平台 Device 均有独立真实证据。
- 数据 migration count/digest/invariant、backup restore、protocol rolling upgrade 和 rollback drill 通过。
- 新 authority 经过观察期，旧 Rust business runtime 停机且无流量、无 fallback、无恢复依赖。
- 旧代码、旧依赖、旧 schema、旧脚本和旧文档完成删除，而不是只停止调用。

在这些条件之前，状态必须写成 `migration in progress`，不能写“全面重构完成”。

## 15. 当前实施状态（2026-08-09）

状态：`migration in progress`。

本轮已经建立的可验证边界：

- TypeScript Run/Step/Attempt authority 允许一个 `run.execute` WorkItem 下存在独立 Model Step 与 Tool Step，
  lease epoch 仍对每次写入做 fencing。
- canonical Model History 是模型上下文事实源；Tool request/result 与取消 marker 不再依赖 UI Message 反推。
- 独立 `packages/context` 已落地 AR-028 bounded normalization；clean projection 保持 cache prefix，orphan/missing Tool
  pair 按 Rust 参考修复，任何 rewrite 都禁止续用旧 Provider checkpoint。canonical Model History 现以 append-only
  compaction item 保存摘要与保留用户消息，Worker 同时按条目和字节阈值触发独立、可恢复的 compaction Attempt。
- SQLite 当前 schema v16（v12 引入 ThreadModelState，v14 引入 AgentVersion Deployment，v15 引入 atomic release bundle，
  v16 引入 persistent Thread Goal）与 InMemory adapter 持久化 Tool Execution Receipt、独立 Tool Approval和唯一 ThreadModelState，Receipt 状态覆盖
  `prepared -> dispatched -> unknownOutcome -> completed|canceled`，Action Digest 与 idempotency key 有唯一约束。
- Tool Provider 边界提供 `execute/reconcile/cancel`；未声明 recovery policy 的已注册 Tool fail closed，
  mutation 只允许 `reconcilable`。
- CrewON Kernel 默认在 Tool 边界结束单次模型段，由 Runtime Worker 持久化 Receipt 后执行 Tool；
  parallel-safe Tool 可并发执行，但结果仍按调用顺序提交。
- Worker 在“Provider 已完成但 Store 事务未提交”的进程退出窗口通过 reconcile 避免重复 mutation；Receipt completion、
  `tool.completed`、Model History result、Tool Step/Attempt、Outbox 与 idempotency receipt 已收敛为同一 fenced Store
  transaction，丢失返回值后的同指纹重试返回 `replayed`，内容变化 fail closed。
- 无法证明的 mutation 结果把 Run 保持在 `reconciling`，不会自动重发副作用；Provider 后续确认时，
  `run.resumed -> tool.completed` 与上述结果状态在同一事务提交。
- 首次 `unknownOutcome` 的 Receipt 迁移、`run.reconciliation.required`、Outbox、当前 Tool Attempt retryable failure 与
  Work Item retry release 已收敛为一个 fenced Store transaction；强制提交失败时 InMemory/SQLite 都保持原 Run、Receipt、Attempt
  和 lease 不变。
- durable Thread resume 直接从 canonical Model History 重建；Provider continuation 必须同时匹配模型身份、history boundary
  与 compaction revision。Thread fork 在 Store 事务内 fence 源 revision，复制冻结的 history/message 前缀并保存 lineage，
  不继承源 Thread 的 Provider checkpoint。SQLite 关闭重开后的 compact/resume/fork 三路径已验证模型可见前缀一致。
- `packages/contracts` 已冻结 `ActionIntent v0` 与 Device WSS v0 的 TypeScript 类型、JSON Schema 和 strict parser：显式绑定
  policy/workspace/resource/credential/execution target/capability/approval/limits，以及 device lease epoch/expiry、
  Run/Step/Attempt、Action Digest、payload 单选、sequenced receipt、unknown outcome 和 ack。该切片没有接真实 Device 或副作用。
- `perAction` Tool 已形成 durable approval 主闭环：Worker 在 Provider 调用前持久化 Approval 并把 Run 置为
  `waitingApproval`；Approval、Run resume 与原 Work Item 唤醒在同一 SQLite/InMemory Store 事务完成。批准后以新 lease epoch
  恢复并重新校验同一 ActionIntent，拒绝后 Provider 调用保持为零。Control API 的查询/决定从 OpenAPI 生成类型，公开投影不泄露
  Action Digest、policy/workspace/resource/credential binding。无人决定的 Approval 会在可配置 deadline 后由重新领取同一 Work Item
  的 Worker 原子标记 `expired`，仍保持 Provider 0 次调用；跨 Action 的主动 supersede 尚未接线。
- 独立 `packages/mcp-runtime` 已通过真实 child-process stdio MCP initialize、分页 `tools/list`、`tools/call` 与关闭流程；
  Runtime Worker 可通过 `CREWON_MCP_STDIO_CONFIG_PATH` 注入多个 MCP server。只有配置中显式声明的
  `readOnly + replaySafe` Tool 会暴露，环境变量是显式 map，二进制/资源链接不进入模型文本。官方 TypeScript SDK 固定
  `1.26.0`，MIT 且完整生产传递依赖许可证 Gate 通过。通用 MCP mutation 因协议没有标准 durable receipt/reconcile 而明确拒绝。
- `apps/device-gateway` 已建立真实 WebSocket Device 会话闭环：Hello 与独立认证身份绑定，command/receipt 按 sequence ACK，
  stale lease/action digest、receipt 变化、sequence gap 和输出超限均 fail closed，断线保留 stable receipt 并返回 `unknownOutcome`。
  生产 entrypoint 强制 TLS 1.3、client certificate 与严格 fingerprint registry；`ws` 固定 8.21.1 且 MIT license Gate 通过。
  dispatch service 已按 stable execution identity single-flight，覆盖续租 replay、request loss、cancel/reconcile 与真实
  WebSocket terminal replay。独立 Worker mTLS 身份通过同一 TLS 1.3 listener 的 `POST /worker/v1/device-dispatch` 进入；Gateway
  SQLite 在发送前持久化 prepared identity，并能在进程重启后 replay terminal receipt。prepared 后结果不可证明时只返回
  非 terminal `unknownOutcome`；新认证 Device Hello 只有显式携带该 execution 的 `lastAcknowledged`，且原 command lease 与
  authorization 仍有效时，Gateway 才发送完全相同的 durable command 以 attach/replay sequence 1，不创建第二次副作用。真实
  mTLS 测试已覆盖断线、Gateway 进程重启、恢复完成与恢复取消。Team PostgreSQL shared execution/route authority 已落地：双 Pool
  prepare 只有一个 initial send，不同 terminal 串行冲突，旧 Gateway epoch 不能 renew/release 新 route。production Team
  entrypoint 已接独立 Gateway mTLS role、静态 HTTPS endpoint、strict single-hop forwarding 和 target-side route recheck；真实网络
  测试覆盖 Worker 命中 non-owner 后经 owner 到 Device，共享隔离 PostgreSQL 15 路径也通过。Gateway 在 route claim 后发送
  TS/Rust shared fixture 对齐的 connection-epoch welcome。最小 Rust `crewon-device` 已提供 bounded raw frame、轮换 Ed25519 PEM
  key、signature/expiry recheck、append-only highest-epoch fence 与 side-effect-start permit。隔离 PostgreSQL 15 上两个独立 Gateway
  子进程进一步通过 owner `SIGKILL` 后的 takeover/reconcile/cancel，副作用启动计数保持 1；当前仍缺把 Native admission 接入真实
  WSS/UDS capability/receipt dispatcher、长断线授权续期和动态设备注册，所以仍不称完整生产 HA。
- `packages/device-dispatch` 已建立 Worker-side Device Tool boundary：Tool Provider command 新增数据库续租得到的
  Work Item/Step/Attempt/lease/expiry identity，Adapter 按 exact policy、Action Digest、Approval、binding、workspace 与 limits
  生成 Device command；开源 Ed25519 signer 的短期 authorization 不超过 durable lease expiry，并与 Rust/Gateway 共用 canonical
  signing payload。`HttpsDeviceDispatchClient` 强制 TLS 1.3/mTLS、bounded body 和 strict operation echo；Runtime Worker 的显式
  `crewon.device-tool-runtime.v0` 配置已绑定 definitions/policies/Device IDs/mTLS/签名路径，并可与 MCP 通过 collision-failing
  Composite runtime 共存。真实本机测试已覆盖 RuntimeWorker Run→durable Approval→Worker HTTPS→Gateway→Device WSS→
  ToolResult→follow-up sampling、unknown→Run reconciling→Device Hello attach/replay→complete，以及
  cancel-requested unknown 保持 reconciling 直到 Provider 证明终态；仍缺 Native execution、HSM/KMS、长断线授权续期和
  多 Gateway HA，因此不是三平台生产闭环。
- `packages/artifacts` 已落地 Standalone Tool-output Artifact v0：领域记录严格绑定 tenant/space/owner、
  run/step/attempt/call provenance、SHA-256/size、retention、AES-256-GCM key ID 与 scan state；SQLite 保存 immutable metadata
  和 `writing -> ready`，内容通过原子文件写入加密。Worker 在 40KB preview 截断前自动持久化完整原文，外部引用必须通过
  exact provenance + digest/size；Control API 授权 metadata/content 不暴露 storage path/key ID，typed client 以 1MiB cap 下载并
  复核 ETag digest。真实 SQLite/loopback E2E 已覆盖 HTTP Run -> Worker 大 Tool 输出 -> 加密 blob -> HTTP 完整读取与磁盘无明文。
  当前仍是 single-host adapter；Team/Cloud S3-compatible store、external KMS/rotation、scan lifecycle、versioned restore 与
  大于 1MiB streaming 尚未完成。
- `packages/test-contracts/fixtures/device-protocol.reference.json` 现在是 TS/Rust Device wire conformance 的共同输入；
  `packages/contracts` 与新的窄边界 `crewon-device-protocol` crate 同时验证 command、Hello、Gateway welcome/connection epoch、ACK、
  cancel、六种 execution event 及同一组 fail-closed error code。Rust crate 只负责 serde/JSON/time/Ed25519 wire validation，不包含
  Run、Thread、模型、数据库或产品策略。
- Device command authorization wire 已冻结 Ed25519 key ID、issued/expiry、可选 digest-bound Approval proof 与 signature；TS/Rust
  对同一 canonical payload SHA-256 达成一致。Gateway 在 dispatch 前以 registry public key 验签，Rust verifier 同时证明 lease
  在签名后变化会被拒绝。开源 private-key signer 与 authenticated Gateway network dispatch、单 Gateway SQLite durable receipt
  和原授权有效期内的 active reconnect 已接线；PostgreSQL shared Store/route fence、Gateway peer mTLS transport 与
  route-epoch welcome wire 已有真实双 Pool/网络/进程强杀证据；Native raw Ed25519 + durable highest-epoch admission 已通过 Cargo
  focused `10/10`。HSM/KMS、长断线授权续期、Native WSS/UDS capability/receipt dispatcher 接线和完整 Native execution 尚未完成。
- PostgreSQL durable queue 基础已使用 MIT `pg` driver 落地：迁移由 advisory transaction lock 串行化，claim 使用数据库时间与
  `FOR UPDATE SKIP LOCKED`，Outbox/Work Item 的 renew/retry/settle 全部复核 owner、lease ID、epoch 与数据库 expiry。真实隔离
  PostgreSQL 15 上两个独立连接池通过 locked-row skip、到期 reclaim、stale owner fencing 和无 sleep retry；该 queue 已由
  完整 `PostgresDomainStore` 与 Runtime Worker 共同消费。
- PostgreSQL Thread Authority 已复用同一 Application Port conformance：Thread snapshot/event、Message、canonical Model History
  与 idempotency receipt 在一个事务提交；目标与 fork source 使用排序 advisory aggregate lock，source revision 在事务内
  fencing。真实 PostgreSQL 15 上 `6/6` 验证 replay、分页、rollback、tenant isolation、fork fence 和两个独立 Pool 的同键
  并发单写。
- PostgreSQL Run Authority 已把 Run snapshot/event、Thread binding、idempotency receipt、Outbox 与 Work Item 收敛为一个事务，
  queue 表通过外键拒绝 orphan handoff；Store conformance + `RunApplicationService` + 双 Pool 幂等竞争为 `14/14`。Step/Attempt
  基础另以数据库时间验证同 lease 多 Step、crash reclaim 后 abandoned/retry lineage，以及 Attempt failure + Work Item retry
  release 原子事务。schema v5 已覆盖 continuation、Tool receipt、Approval 与 ThreadModelState 的 v1 升级路径；完整 execution conformance
  `16/16` 与 PostgreSQL focused `18/18` 覆盖 text completion/replay、canonical Tool history、unknown outcome/reconciliation、
  Approval hold/wake/expire/supersede、context compaction、terminal settlement 和强制冲突整笔 rollback。
  migration preflight 会在执行 DDL 前拒绝更高 schema version，防止旧二进制改写新数据库。
- Control API 与 Runtime Worker 的生产 composition 已支持 `CREWON_CONTROL_DATABASE_URL` 与独立 schema。Runtime Worker 在
  PostgreSQL 上通过同一套 `8/8` Worker conformance；两个真实子进程竞争单个 Run 时严格只有一个执行，另一个返回 idle。
  SIGKILL 后由新进程按数据库 lease reclaim，Attempt lineage 为 `abandoned -> retryOf -> completed`，assistant Message 只提交一次。
- Direct Responses 的显式 `responsesLite` profile 已与 Rust 共用 request fixture：HTTP/WebSocket 都发送
  `reasoning.context=all_turns` 并关闭 parallel tool calls；默认 `standard` 不发送 OpenAI 特定字段。WebSocket fallback/sticky
  与单连接 incremental suffix/`previous_response_id` 也已由 Rust+TS 共用 fixture。AR-006 保留 durable audit `[1,2]`，
  Control API 默认 `view=client` 投影 `[2]`、显式 `view=audit` 返回全部事实，不依赖 build mode。
- AR-026/027 的 import-only legacy rollout compiler 已区分 event_msg UI history 与 response/replacement model history，
  通过 SQLite commit/replay、关闭重开 resume、真实 fork transaction 和 Rust shared fixture；无法无损表达的旧条目 fail closed。
- AR-030 将 HTTP `cyber_policy` 映射为 typed non-retryable failure；Rust/TS shared fixture 证明单请求、0 sampling retry、
  无 assistant Message 且释放执行槽。
- immutable AgentVersion compiler 已在 Store open/Provider prewarm 前冻结 instructions、transport/model identity、Tool 顺序、
  context/compaction 和 retry policy，并支持 reviewed expected digest 启动 Gate。SQLite v15/PostgreSQL 独立 authority 已持久化
  tenant-scoped immutable asset；Control API 完成授权 publish/get/list，Worker 以 `tenantId + agentVersionId` single-flight 懒加载、
  重验 source digest 并接管旧版本 prior-compactor。Control API 已支持 optional selected-version Run，并以 exact
  ID/digest/authority/workspace admission 在服务端派生路线。default/selected-version 已改用 SQLite v15/PostgreSQL authority v3
  的 digest-addressed release bundle：独立 release 进程编译 materialization digest，经 `agentVersion:publish/deploy` 授权，
  在单事务内提交全部 Deployment、operator audit 与 active pointer；activation ID 可安全重放，并发 activation 以 CAS fencing。
  Worker 只读已登记 bundle（包括用于 pinned Run 恢复的 historical bundle），Control 只接受 active bundle；任一重绑都 fail closed。
  配置化 runtime factory 可为每个 tenant/version 建立独立
  Direct Responses endpoint、credential env、request profile、workspace、Tool/MCP 与生命周期，任一 digest/model/workspace 漂移
  fail closed。release metadata 编译不读取 Provider credential；bootstrap asset/deployment 缺失或同 ID 不同内容都会使 Control
  admission 或 Worker 启动 fail closed。
- `packages/control-client` 已提供基于 generated contract types 的 Thread/Message/fork、Thread Goal get/set/clear、Run、AgentVersion、
  Approval、Artifact typed client、digest-verifying bounded Artifact download、Run SSE 与独立 Goal SSE；没有 generic authenticated
  fetch surface。Goal GET 原子返回 `{goal,eventSequence}`，event sequence 只用于 snapshot -> SSE handoff，mutation CAS 仍使用 Goal revision。
  Control API/Client 现已补齐 tenant/space scoped Thread 列表与 Thread -> Run keyset 分页查询，刷新后可从 durable authority
  恢复会话和 active Run。CrewON UI production composition 已可在取得 Control session 后把 Thread 列表、创建、读取、Turn、cancel、
  Run SSE 与 Goal snapshot/SSE 整体交给 bounded Control adapter；配置 Control 后未连通时 fail closed，不把旧 AppServerClient
  当隐式 fallback。Goal/Plan 旧预写已删除，旧 Goal notification 也不再参与排序。Vite 开发 BFF 的 bearer 只留服务端，Renderer
  仅持短期 CSRF/session。macOS arm64 packaged PC 已用官方 Node 24 实包验证 Control API/release/Worker 监督、typed IPC bootstrap、
  ready Gate 与无 orphan；生产 Web 已落地独立 BFF、BFF service credential、request-scoped Identity/Policy composition 和 source
  Gate。OS Keychain Provider credential 与受监督 runtime replacement 已通过 macOS Tauri Gate；尚未完成 Windows/NSIS 实包、
  签名/updater、live Provider canary 与真实 Identity/PIM staging，因此还不能默认
  启用或删除 legacy client。UI lint 与 production build 通过；完整 UI 为 `1695 passed / 1 failed`，唯一失败仍是共享工作区既有
  `CommandWorkspaceConversationStyle` CSS snapshot 漂移，本批未擅自接受。InMemory/SQLite 及隔离 PostgreSQL 15 的 Thread/Run conformance 均已覆盖新增 cursor 查询，PostgreSQL
  focused 为 `22/22`。原子 `turn/start` 已把 user Message、Thread/Model History、Run、Outbox 与 Work Item 收敛为一个
  idempotent Store transaction，并在 Thread 锁内强制最多一个非终态 Run；CrewON Control adapter 已只使用该单请求路径。
  InMemory/SQLite conformance 各 `6/6`，覆盖 replay、并发单赢家、Goal 原子创建/绑定、Plan 原子清除和 queue
  校验失败整笔 rollback；隔离 PostgreSQL 15 已实际执行 Store `257/257`、Runtime Worker `121/121`、Control API `42/42`，全部
  0 failed、0 skipped，包含 Goal/Plan transaction、schema/drain Gate、双 Pool/进程竞争、SIGKILL recovery 和 snapshot/event cursor handoff。
  升级读取仅把同时缺失新字段的旧 Run snapshot 规范化为 `default + null`；半缺失、非法 mode 或 Plan 绑定 Goal
  仍 fail closed，避免旧数据在公开投影中静默缺字段。
  receipt replay 会在 Thread/Run 双授权通过后、当前 release route 解析前按原始语义 fingerprint 查询；因此已提交的
  selected-version Turn 在该版本退出 active release 后仍可精确回放，而使用相同旧版本的新请求会被 admission 拒绝，不能因
  rollback 改写历史结果或回退到默认版本。
  Control API/typed client 已提供 active AgentVersion catalog，只投影 active release ID、激活时间、默认版本及安全模型元数据，
  不暴露 instructions、authority、workspace 或 materialization 数据。CrewON Control adapter 每次启动 Turn 都将默认/Agent target
  解析为活动目录中的确切 `agentVersionId`，并校验 UI model 与该版本绑定的 `modelId`；inactive Rust Agent config ID、未知目标或
  model/version 不一致均在 mutation 前 fail closed。application、contract、client、Control API 和 UI focused tests 当前分别为
  `39/39`、`35/35`、`10/10`、`18 passed + 2 PostgreSQL process skipped`、`7/7`。
  Goal/Plan 已进入严格 OpenAPI、generated client、Control adapter 和原子 `turn/start`：Goal 是 revision-fenced Thread authority，
  每个 Run 固定 `collaborationMode + goalBinding`；Plan 会在同一事务清 Goal、只向模型暴露服务端判定的 read-only Tool，
  注入 server-owned Plan instructions，并要求唯一 `<proposed_plan>` 终态。Run 现在聚合 sampling/compaction usage；text success、
  cancel、不可恢复错误和 usage limit 会在同一 fenced terminal transaction 结算 Goal token/time/status。finite-budget active Goal 的
  text success 会在该 transaction 中直接创建下一 Run、内部 continuation context、Outbox 与 Work Item，不把内部 prompt 伪装成
  Thread 用户消息。新 TS Goal 默认有 `200000` token safety budget；显式 unbounded Goal 也会跨多轮 durable continuation
  继续运行。Worker 在采样前
  重验 Goal ID、revision 与 objective digest。模型可调用的 server-owned `get_goal/create_goal/update_goal` 已按 Rust
  response/status 语义接入；
  它们不是 AgentVersion 资产，也不进入外部 Tool Provider。只有 default 且已绑定 Goal 的 Run 才注入，Plan 不注入，名称碰撞或
  与外部 Tool 同批调用均 fail closed。`update_goal` 在 fenced Store transaction 内结算当前 Run 的累计 token/time、CAS Goal 并写
  call-ID 幂等回执；进程在 Goal commit 与 `tool.completed` 之间丢失时只重放回执，不重复计费，complete/blocked 会阻止 terminal
  text 再创建 Goal continuation。`create_goal` 不动态重绑当前 Run：工具事务创建新 Goal，但当前 Run 的既有 usage 不追溯归属；
  terminal text transaction 原子创建绑定新 Goal revision 的 continuation Run。未显式提供 `token_budget` 时仍应用 TS 的
  `200000` safety budget；下一 Run 才开始计费。queued admission 继续严格校验 Goal binding，已经进入 running 的 continuation
  不会因本 Run 自己调用 `update_goal` 后 revision 变化而被误判 stale。Control API/typed client 现已提供授权的
  `GET /threads/{threadId}/goal`，原子返回 Goal ID/revision、目标、状态、预算/用量、时间戳与同读点 eventSequence，不暴露
  tenant/space/actor；
  Application 会先验证 Thread scope 再读取 Goal，跨 space 不会泄露 Goal 是否存在。直接 Goal set/clear 的 authorized
  Application command 与 InMemory/SQLite/PostgreSQL compound transaction 已落地：revision CAS、idempotent receipt、queued
  Goal-owned Run 退休、Work Item settlement 与 replacement activation 原子提交；普通 queued user Turn 不会被 Goal prompt 吞掉，
  pause/no-op/replay 不依赖 route resolution。running/queued manual Run 现在以 event-sourced `RunGoalAccountingCursor` 在同一
  transaction 结算 mutation 前的 uncached-input/output 与 started-time 区间，再原子 rebind/detach；旧 bound non-terminal Run
  缺 cursor 时 fail closed，不猜测是否已经结算。objective edit 会留下 bounded durable handoff，Worker 在 pending Tool 完成后、
  下一次模型请求组装前把 `goal_steering` 与 `run.goal.steering.consumed` 原子提交；连续编辑只消费当前 handoff。text terminal、
  failure/cancel terminal 与 `update_goal` 已使用 cursor delta，terminal 前追加 accounting checkpoint，避免 external edit 后因 immutable
  initial binding stale 而漏计或双计。普通 Tool completion 也在 Tool receipt/History/Attempt 的 fenced transaction 中结算 cursor
  增量，并仅在首次跨预算时留下下一采样前 exactly-once 消费的 `budgetLimited` steering。cancel 按 Rust 语义保持 active Goal 但不立即
  continuation；generic error 与 usage limit 分别落为 blocked/usageLimited。PostgreSQL terminal 已改为 receipt-first replay 和统一
  idempotency -> Run -> Work Item -> Thread/Goal 锁序。Goal Tool receipt 也携带最终 Run/cursor/event/outbox。Goal get/set/clear 与独立
  durable Goal event SSE 已开放 Control API；六类 Goal writer 同事务追加 changed/cleared event，TurnStart/terminal/Goal Tool 均已
  receipt-first 并统一 run -> thread 锁序，settled-lease replay 与真实 PostgreSQL concurrency 已执行。Goal objective 已对齐 Rust 的
  4000 Unicode scalar 上限；Rust/TS continuation、objective-update 与 budget-limit 都会 XML escape，并把包含 runtime marker 的完整
  context item 限制在 9999 UTF-8 bytes。Responses cached input 已进入 Kernel/Run usage，Goal 按 Rust 的
  `uncached input + output` 计费，旧 event/snapshot 缺字段时只规范化为 0。两份 Rust/TS shared fixture 已关闭 continuation、Tool/budget、
  terminal precedence、objective edit/clear、幂等与不可复活差分；`timeUsedSeconds` 明确采用 Goal-attributed started-Run elapsed 的
  intentional redesign。Goal runtime focused Gate 已为 `PARITY（含 intentional redesign）`；CrewON UI 的 Control 切流、
  Goal/Plan 原子发送和 Plan 专用 durable Message/event/UI projection 已接入。Plan 正文只在 terminal Message 中保留一份，
  `plan.proposed` SSE 不复制正文；断线后由 Thread refresh 恢复专用 Plan item。真实 Identity/PIM staging 和三平台发布仍未验收。
  本批 evidence：workspace typecheck `20/20`，UI TypeScript lint 通过；19 个有测试脚本的新架构/服务包 `780/780`，真实 PostgreSQL 路径
  0 skipped；Rust
  `crewon-goal-extension 26/26`、`crewon-state 242/242`、`crewon-app-server thread_goal 5/5`。
  图片、Team/Experts 仍会 fail closed，不会被降级为普通对话。
  真实 SQLite backend vertical slice 已覆盖 client publish -> selected Run -> durable Worker exact runtime -> assistant Message。
  该 adapter 已能在 Control session 存在时接管真实 CrewON UI Thread/Run/Goal I/O；macOS arm64 packaged runtime 与 Web BFF/
  production composition 的本机边界已经落地，OS Keychain Provider credential、active-Run admission fence 和 supervised
  Control/Worker replacement 也已通过 Tauri/macOS Keychain 测试；但图片、Team/Experts、Windows/签名、live Provider、live Identity/PIM 与
  其他缺失能力补齐前，不能称完整用户纵向闭环。
- Context-window compaction retry 已与 Rust 共用 AR-025 fixture：SSE/HTTP 的 `context_length_exceeded` 先映射为安全 code，
  compactor 在同一 durable Attempt 内每次丢弃一个最老 history item并保持 prompt 稳定，成功前不提交 compaction Authority。

尚不能据此声明完成的部分：

- Kernel 只读取 Tool Catalog 并在结构化 Tool boundary 交还控制权；旧 Tool execute/resample 内循环与 `invoke` Port 已删除，
  Tool execution authority 只在 Runtime Worker。
- InMemory Tool Provider 是 deterministic adapter，不是生产 Device/Cloud Executor；真实副作用 Tool 仍未启用。
- 正常完成、首次未知结果转 reconciliation 与已确认 reconciliation 的结果提交窗口已经关闭；legacy partial receipt repair
  仍保留 fail-closed recovery 分支。
- PostgreSQL LISTEN/NOTIFY、备份恢复、staging chaos/SLO、Team Artifact object store/KMS/scan/streaming、Device HSM/KMS signer、长断线授权续期、Native WSS/UDS capability/receipt dispatcher 与完整 Runtime、前一协议版本兼容与 Kotlin/Swift client、MCP mutation/remote HTTP auth、Approval 跨 Action 主动 supersede、legacy 批量 discovery/dry-run/cutover、
  Windows packaged PC/签名、production Web live Identity/PIM 与 live Provider 验收、Workflow/Office、
  三平台 Native Runtime、canary/cutover 与旧 Rust 业务运行时删除仍未完成。
- 当前证据是 local deterministic/SQLite 加隔离 PostgreSQL 15 完整 DomainStore、Worker conformance 与进程级竞争/强杀恢复，
  不外推为 staging、production、备份恢复、跨主机网络分区或 live provider 通过。
