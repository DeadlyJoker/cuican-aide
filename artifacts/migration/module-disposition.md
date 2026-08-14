# CrewON 迁移模块处置清单 v1

状态：Pure TypeScript cutover
日期：2026-08-14
上级计划：[MIGRATION_PLAN.md](../../MIGRATION_PLAN.md)

本清单是开始迁移的最小真实台账。它按行为所有权归类，不代表一个目录只能整体保留或整体删除。任何模块开始改写前
必须继续细化到 owner、入口、fixture、数据和副作用；任何 `KEEP_NATIVE` 都需要 symbol/callsite 审计，不能整 crate
自动搬入最终 runtime。

## 处置定义

| 标记            | 要求                                        |
| --------------- | ------------------------------------------- |
| `PORT_EXACT`    | 外部结果、不变量和 event trace 等价         |
| `PORT_REDESIGN` | 契约等价，内部并发/持久化/模块边界重做      |
| `KEEP_NATIVE`   | 只提取平台原语，删除产品 domain 依赖        |
| `GENERATE`      | 从 OpenAPI/JSON Schema 生成，不手写两套 DTO |
| `IMPORT_ONLY`   | 只读旧格式或迁移，不能进入正常运行          |
| `DELETE`        | 不迁移；达到调用和观察 Gate 后删除          |

当前迁移不为 Rust 旧实现保留双读、双写、回退或行为兼容。旧数据 importer 仅在已确认必须保留生产数据时才允许单独立项；
当前 Workflow 与 Office 数据均直接切到新 Store authority，不实现旧 `.crewon` 文件或 Rust snapshot importer。

## Agent、Context 与 Model

| ID  | 当前路径                                                    | 处置                            | 最终所有者                     | 核心证据/删除 Gate                                      |
| --- | ----------------------------------------------------------- | ------------------------------- | ------------------------------ | ------------------------------------------------------- |
| A01 | `codex-rs/core/src/session/turn.rs`、`tasks/regular.rs`     | `PORT_REDESIGN`                 | `packages/agent-kernel`        | fake-model 全事件 trace、cancel/resume/budget 等价      |
| A02 | `codex-rs/core/src/client.rs`                               | `PORT_EXACT` + `PORT_REDESIGN`  | `packages/agent-responses`     | HTTP/WS request、stream、prewarm、fallback、错误矩阵    |
| A03 | `codex-rs/core/src/context/**`、`context_manager/**`        | `PORT_EXACT`                    | `packages/context`             | canonical request-body diff、hard cap、cache stability  |
| A04 | `codex-rs/core/src/compact*.rs`、rollout compaction 行为    | `PORT_EXACT`                    | `agent-kernel` + `context`     | compaction fixture、续接后 history/request 等价         |
| A05 | `codex-rs/model-provider-info`、`model-provider`、transport | `PORT_EXACT` + `PORT_REDESIGN`  | `packages/model-providers`     | provider conformance、secret/routing/error tests        |
| A06 | `codex-rs/rollout*`、session reconstruction                 | `PORT_REDESIGN` + `IMPORT_ONLY` | domain/store + legacy importer | active state 由新 event model 恢复；旧 rollout 只读导入 |
| A07 | `codex-rs/core/src/realtime_*`                              | 单独评审                        | optional realtime adapter      | 不得混入 text Kernel；有独立产品需求和协议后迁移        |
| A08 | `@openai/agents`（当前无依赖）                              | 可选新增                        | `packages/agent-openai`        | 不安装也能启动；SDK 类型/状态不出 Adapter               |

## Tool、MCP、Policy 与 Execution

| ID  | 当前路径                                                            | 处置                           | 最终所有者                    | 核心证据/删除 Gate                                      |
| --- | ------------------------------------------------------------------- | ------------------------------ | ----------------------------- | ------------------------------------------------------- |
| T01 | `core/src/function_tool.rs`、`mcp_tool_call.rs`、approval templates | `PORT_EXACT` + `PORT_REDESIGN` | Tool Broker + policy          | schema/order/error/approval/action digest trace         |
| T02 | `crewon-mcp`、`rmcp-client`、app-server MCP processors              | `PORT_REDESIGN`                | `packages/mcp-runtime`        | discovery/refresh/failure/secret/concurrency suite      |
| T03 | `core/src/exec_policy.rs`、network/safety/guardian policy           | `PORT_EXACT`                   | `packages/policy`             | deterministic decision + redacted reason fixture        |
| T04 | `apply-patch`                                                       | `KEEP_NATIVE`                  | `crates/crewon-filesystem`    | atomicity/path/diff/size conformance；只提取必要 symbol |
| T05 | `exec-server`、`shell-command`、`process-hardening`                 | `KEEP_NATIVE`                  | `crates/crewon-process`       | process tree、PTY、cancel、output/resource cap          |
| T06 | `linux-sandbox`、`sandboxing`、`windows-sandbox-rs`                 | `KEEP_NATIVE`                  | `crates/crewon-sandbox`       | macOS/Linux/Windows platform security suite             |
| T07 | `shell-escalation`                                                  | `KEEP_NATIVE` 或 `DELETE`      | Native Runtime capability     | 有明确产品能力和审批模型才保留；否则删除                |
| T08 | `apps/crewon-ui/src-tauri/src/**`                                   | `KEEP_NATIVE` 并保持极小       | Tauri shell                   | 只允许 window/update/deep-link/sidecar lifecycle        |
| T09 | `command_exec`、`process_exec_processor`、`fs/git/windows` RPC      | `PORT_REDESIGN` 后删除         | Tool Broker + Device Protocol | UI/API 不再直接表达 OS 命令；新协议通过后删旧 RPC       |

## Control API、Thread 与 Store

| ID  | 当前路径                                                        | 处置                           | 最终所有者                   | 核心证据/删除 Gate                                   |
| --- | --------------------------------------------------------------- | ------------------------------ | ---------------------------- | ---------------------------------------------------- |
| C01 | `app-server-protocol` v2                                        | `GENERATE`                     | `packages/contracts`         | OpenAPI/SSE schema compatibility；客户端生成         |
| C02 | app-server protocol v1、unsupported-RPC fallback                | `DELETE`                       | 无                           | client version 截止、网络调用为 0、观察期后删除      |
| C03 | `message_processor.rs`                                          | `PORT_REDESIGN` 后删除         | Control API route modules    | 每条 RPC 有 REST command/query 或明确 DELETE         |
| C04 | `request_processors/thread_processor.rs`、turn/lifecycle/delete | `PORT_REDESIGN`                | application/domain/store     | Thread/Run contract、idempotency、resume/fork/delete |
| C05 | state DB、rollout/session persistence                           | `PORT_REDESIGN`                | SQLite/PostgreSQL adapters   | store conformance、migration digest、crash recovery  |
| C06 | config processors/ConfigToml                                    | 分项 `PORT_EXACT`/`DELETE`     | typed settings + secret refs | setting inventory；未知/旧配置不能自动复制           |
| C07 | search/fs watch/fuzzy search                                    | 分项 `PORT_REDESIGN`           | query service/Device Runtime | path authority、bounded result 和 cancellation       |
| C08 | analytics/telemetry/error mapping                               | `PORT_EXACT` + `PORT_REDESIGN` | observability                | error taxonomy、redaction、span/event compatibility  |

## Workflow、Office、Experts 与 Automation

| ID  | 当前路径                                                                 | 处置                      | 最终所有者                      | 核心证据/删除 Gate                                  |
| --- | ------------------------------------------------------------------------ | ------------------------- | ------------------------------- | --------------------------------------------------- |
| W01 | `crewon_domain_workflow*.rs`、`workflow_node_dispatch.rs`                | `PORT_REDESIGN`           | workflow-runtime                | 六态、Human Gate、cancel/restart、本地 Agent thread |
| W02 | `.crewon/workflows/*.json` legacy definition                             | `DELETE`（已关闭）        | 无                              | 新 Store authority 生效；不实现 importer/dual-read  |
| W03 | `crewon_domain_office_run.rs`、message/receipt/recovery/authority 文件族 | `PORT_REDESIGN`（已切换） | unified Run + Office projection | receipt、recovery、owner、message intent fixtures   |
| W04 | Office legacy mutation、专用 scheduler state、旧 auto-dispatch           | `DELETE`（已关闭）        | 无                              | 统一 Run cutover、零调用、drain/观察期              |
| W05 | Office migration importer/snapshot/targets                               | `DELETE`（已关闭）        | 无                              | 新 Store authority 生效；不实现 importer/dual-read  |
| W06 | `automation_scheduler.rs`、automation binding                            | `PORT_REDESIGN`（已切换） | application + workflow-runtime  | schedule/misfire/dedupe/timezone/owner tests        |
| W07 | `experts_processor`、Office manager/member delegation                    | `PORT_REDESIGN`（已切换） | AgentVersion + Run/Step         | 委派 durable，不隐藏内存 handoff                    |

### W02–W07 pure TypeScript cutover evidence（2026-08-14）

- **W02**：production source graph 不再读取 `.crewon/workflows/*.json`。最后一组无调用的 `CommandWorkflowPanel`、
  legacy parser 和对应测试已删除；当前 Workflow UI 只使用 generated Control client 与 `ControlWorkflowPanel`。
- **W03 / W07**：Office create/get/list 与显式 delegation start/list 均由 Control API 暴露。delegation fresh transaction
  固定 OfficeVersion、WorkflowVersion、Thread、成员 AgentVersion 与 route，原子创建 canonical Workflow Run、root input、
  scheduler WorkItem、event/outbox 和 receipt；replay 不再次 prepare 或执行。Office/Experts 不拥有第二套 Run reducer。
- **W04**：production composition 不包含 Office 专用 scheduler、legacy message delivery、auto-dispatch 或内存 handoff。
  Office 只定义成员边界，执行统一进入 Workflow scheduler 与 Runtime Worker。
- **W05**：没有 legacy Office snapshot/importer、dual-read 或 dual-write production 入口；新 SQLite/PostgreSQL Store 是唯一
  Office 与 delegation authority。按本次 breaking cutover 决策不迁移迁移期未使用的旧数据。
- **W06**：Automation schedule v1、due lease、occurrence receipt、misfire/coalesce、timezone、owner freeze 与 canonical Run
  admission 已接入 standalone SQLite 和 production PostgreSQL；Automation scheduler 只创建统一 Run。

这些状态只关闭 WS4 的旧兼容路径与统一 Run cutover，不代表 Provider、MCP、Resource/PIM、三平台发布签名和运维 Gate
已经完成。

## Identity、Provider、Resource 与 Artifact

| ID  | 当前路径                                                   | 处置                           | 最终所有者                       | 核心证据/删除 Gate                                  |
| --- | ---------------------------------------------------------- | ------------------------------ | -------------------------------- | --------------------------------------------------- |
| P01 | `platform_control/**` principal/session/revocation         | `PORT_EXACT` + `PORT_REDESIGN` | identity/application             | tenant/space/actor/expiry/revocation/security suite |
| P02 | provider connection/identity/access grant/resource catalog | `PORT_REDESIGN`                | resource/model provider adapters | owner/scope/revision/credential isolation           |
| P03 | `provider-agent-platform`、cloud agent processors          | Adapter 或 `DELETE`            | external agent provider          | 只保留显式外部资源；不得成为本地 Workflow fallback  |
| P04 | artifact/context/credential adapters                       | `PORT_EXACT` + `PORT_REDESIGN` | artifacts/context/identity       | digest/provenance/secret ref/retention tests        |
| P05 | Marketplace/商业 provider 启动依赖                         | `DELETE`                       | optional adapters only           | 关闭商业能力后核心主链路通过                        |

## React 客户端

| ID  | 当前路径                                                      | 处置                          | 最终所有者                        | 核心证据/删除 Gate                                |
| --- | ------------------------------------------------------------- | ----------------------------- | --------------------------------- | ------------------------------------------------- |
| U01 | `src/lib/app-server/**`                                       | `DELETE`（已关闭）            | generated Control API client      | PC/Web 同 schema；SSE resume；旧 WS 调用为 0      |
| U02 | `src/lib/agent-platform/**`、direct session/catalog/execution | `DELETE`（production 已关闭） | Control API resource queries      | 浏览器网络审计无 direct execution/secret          |
| U03 | `src/lib/thread/**`                                           | 保留 presentation，重写 I/O   | feature/thread + generated client | projection/interaction snapshot                   |
| U04 | `src/lib/workflow/**`、`src/lib/office/**`、automation        | 保留 presentation，重写 I/O   | feature packages                  | fail-closed parsing、统一 Run/Approval projection |
| U05 | large app workspace coordinators                              | 分 feature `PORT_REDESIGN`    | feature composition               | 无 domain authority、无 provider direct path      |

### Renderer Control-only cutover evidence（2026-08-14）

- **U01**：Renderer 不再导入 App Server transport/authority，fresh production bundle 的 AppServer、WebSocket 6176 与 restart
  marker 为 0；Thread、Run、Workflow、Office、Automation、Settings 与 Workspace 均使用 generated Control client。
- **U02**：production entry 不再挂载 `AgentPlatformAuthGate`、PIM launch token 或默认 `127.0.0.1:8000` /
  `/agent-platform-api` proxy；首页不再 mount-time 读取 agent-platform catalog。Agent/Knowledge 旧 catalog mutation 在没有 Control
  contract 时明确 fail closed，不能直连 Provider/PIM 冒充迁移完成。遗留未导入模块可继续机械删除，但不属于 runtime authority。
- packaged desktop 仍在 Control client 构造前安装 Tauri HTTP transport。这只为 `tauri.localhost` 到 authenticated loopback
  Control API 绕过 webview CORS，不是 Rust App Server/PIM fallback，也不拥有产品语义。

## 必须新增但不从旧代码复制的模块

| ID  | 新模块                         | 原因                                                                    |
| --- | ------------------------------ | ----------------------------------------------------------------------- |
| N01 | `packages/contracts`           | wire source of truth 和跨语言生成                                       |
| N02 | `packages/domain`              | 纯 Run/Step/Attempt/Event/Approval 状态机                               |
| N03 | `packages/agent-kernel`        | 自有 TS Agent loop 与 durable segment                                   |
| N04 | `packages/store`               | SQLite/PostgreSQL conformance、lease、outbox                            |
| N05 | `packages/execution-contracts` | Device command/receipt/reconcile 独立于产品 domain                      |
| N06 | `packages/test-contracts`      | Rust reference、TS candidate、fake provider/device 共享 fixture         |
| N07 | `apps/control-api`             | REST/BFF/SSE command/query boundary                                     |
| N08 | `apps/runtime-worker`          | durable Agent/Workflow execution owner                                  |
| N09 | `packages/tool-broker`         | provider-neutral Tool schema、幂等调用、输出与并发/取消边界             |
| N10 | `packages/device-dispatch`     | durable Tool lease 到 mTLS Gateway signed Device command 的 Worker 边界 |

## 台账更新规则

每一项进入实现前追加：

```text
owner
behavior ids
source entrypoints and callsites
data read/write set
side effects
target package
fixture/trace ids
entry gate
cutover cohort
rollback behavior
deletion gate
verified environment and date
```

若无法回答数据权威、重复副作用和回滚方式，该项保持 `blocked for design`，不能通过“先翻译再说”绕过。
