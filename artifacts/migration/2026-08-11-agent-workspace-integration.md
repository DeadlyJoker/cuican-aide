# Agent Runtime 与 Native Workspace 集成证据

日期：2026-08-11  
分支：`codex/agent-runtime-migration-20260811`  
状态：本纵切已集成并验证；完整迁移仍在进行中

本文只记录当前分支可复现的集成证据，不替代 `ws1-implementation-status.md`，也不把本机 macOS 结果外推为 Windows、Linux、Team 或生产发布完成。

## 本轮落地范围

- 基础 Agent Runtime 对齐了缺失 `response.completed` 时的 completed assistant / Tool item history boundary，并关闭了同一 response
  混合 completed assistant/commentary 与 Tool call 的剩余缺口。Rust integration 直接断言第二次 `/responses` 请求；TS Kernel、
  Responses transport 与 durable Worker 共用 bounded fixtures。completed assistant 按顺序进入 canonical history，但不形成 terminal
  Message；Tool call/result exactly-once 后继续 sampling，最终只提交 follow-up assistant。只有裸 partial delta、没有
  `output.item.completed` 证明的文本仍在任何 Tool 副作用前 fail closed。
- Workspace top-level list 已贯通 Contracts → Application → Store → Device Dispatch → Gateway → Runtime Worker → Control API / Client。
  execute、reconcile、cancel、receipt-first replay、route epoch、delivery lease、accepted/terminal commit-before-ACK 与 SQLite restart authority
  均进入分层测试。
- Rust Native Device 已贯通 signed command、stable directory handle、epoch takeover、SQLite journal、sequence 1/2 event 与 cumulative ACK。
  当前 connection 的命令不再错误依赖首个 Welcome 中静态的 route lease deadline；Welcome admission、command expiry、签名、binding、incarnation
  与 takeover fence 仍保持。
- Tauri desktop 已落地 native Workspace catalog、candidate/commit/admission fence、Gateway → Device → Worker → Control 启动顺序、provider reload、
  process guardian 与 sidecar packaging。所有新增/高触达生产 Rust 模块均低于 500 行。
- React UI 已接入真实 native Workspace selector、“无工作空间”、Control Workspace operation rail 与 SSE recovery。
  Renderer 不接收绝对路径，不调用 legacy filesystem fallback；Scene、execution target 与 Workspace authority 保持正交。
  `CommandWorkspaceChrome.tsx` 已拆为 470 行主协调文件以及 Tree、Search、Roster Controller、Palette、Account siblings；Workspace operation panel
  与 Control runtime 也均低于 500 行。

## 主分支验证

| 层                     |                   结果 | 说明                                                                   |
| ---------------------- | ---------------------: | ---------------------------------------------------------------------- |
| Agent Kernel           |                20 / 20 | completed assistant / Tool、mixed fail-closed                          |
| Agent Responses        |                28 / 28 | HTTP / WS、completed item、fallback                                    |
| Rust core focused      |                  4 / 4 | `stream_no_completed`，828 个无关 case 过滤                            |
| Contracts              |                69 / 69 | typecheck、test、license、generate-check                               |
| Application            |              110 / 110 | clean committed-tree Agent + Workspace authority                       |
| Device Dispatch        |                37 / 37 | signer、executor、client、certainty                                    |
| Store                  | 263 passed、46 skipped | SQLite/migration/conformance通过；本轮无 PostgreSQL URL                |
| Device Gateway         |   92 passed、6 skipped | local/TLS/peer/session/receipt；PG 条件测试跳过                        |
| Runtime Worker         |  164 passed、1 skipped | clean committed-tree Agent + Workspace private server；PG 条件测试跳过 |
| Control API            |   89 passed、3 skipped | public Workspace routes/SSE/client；PG 条件测试跳过                    |
| Native Rust crates     |                62 / 62 | protocol 3、journal 14、device 27、runtime 18                          |
| Tauri                  |                99 / 99 | strict Clippy 通过                                                     |
| Staging config         |                13 / 13 | sidecar manifest、Node/native probes                                   |
| CrewON UI cutover Gate |                  8 / 8 | legacy Thread 零调用；lint 与 production build 通过                    |

Workspace UI 另在只含 committed `HEAD` 的独立 `git archive` 中验证：9 个 focused files、125 tests、lint、production build 全部通过。
该 Gate 暴露并修复了对未提交 Contracts `eventSequence` 扩展的隐式依赖；Workspace Thread authority 现在只消费 canonical
`GetThreadResponse.thread` 的 identity、revision 与 status。

## 后续 clean committed-tree Gate

- 新 Codex worktree 从已提交分支启动后首先暴露共享
  `device-protocol.reference.json` 的 Workspace command/ACK/event fixture 仍只存在于主工作树。fixture 已作为独立提交补入；
  `crewon-device-runtime` clean-tree full test 从 6 个反序列化失败恢复为 18 / 18。
- Device Runtime 不再完全吞掉 reconnect/session 错误，也不恢复无界 `eprintln!`：stderr 诊断按 60 秒窗口去重，每窗口最多 8 个
  不同的 `&'static str` 稳定错误码，不格式化 source；stdout ready line、terminal、replay 与重连语义不变。新增 4 个无 sleep
  diagnostics tests，scoped fix 与 fmt 通过。
- Legacy Thread cutover 新增 AST + production authority Gate，覆盖 list/read/create/fork/archive/unarchive/rename/delete、Turn/Run、
  Goal、Plan、compact 与 rollback。Control 配置后断线必须 fail closed；未配置 Control 的 legacy-only cohort 仍可运行。调用图证明
  account/config、Native workbench、MCP/catalog、external resources、Workflow/Office/Automation/Human Gate、memory/settings 和 packaging
  仍依赖 compatibility sidecar，因此没有提前删除 `crewon-app-server`。
- Agent mixed-response shared trace 同时冻结 Rust 与 TS：completed commentary → custom Tool call → 一次 Tool result → follow-up sampling；
  第二请求后缀、stable event order、terminal usage、exactly-once Tool invocation 与唯一 terminal Message 自动 deep-equal。
- clean worktree 还暴露 committed `ThreadStore` 缺少 space-scoped authority、三种 Store 未实现 `loadThreadInSpace`、Workspace read/write
  未进入 authorization action，导致 Runtime private server 安全返回 503。修复后使用独立必需 `SpaceScopedThreadStore`；PostgreSQL
  在 SQL `WHERE` 中同时约束 tenant/space/thread，SQLite/InMemory 在 Store 边界核验 space，不使用 optional invocation 或 fallback。
- 最终 clean Gate tree 与主分支 committed tree ID 均为 `16b31191749885b30482299b328d0012f3fabad9`。组合验证：Agent Kernel
  20 passed、Application 110 passed、Runtime Worker 164 passed、Store scoped 167 passed，共 461 passed、0 failed；Runtime Worker 和
  PostgreSQL Thread conformance 各因未设置 `CREWON_TEST_POSTGRES_URL` 条件跳过 1 条，未报告为通过。所有对应 typecheck 通过。
- clean UI worktree 的 legacy cutover focused 8 / 8、lint、production build 通过。其意外触发的 full UI suite 仍有一条既存
  `CommandWorkspaceConversationStyle` CSS snapshot mismatch；本切片未把该无关视觉漂移静默接受为新基线。

## Agent Runtime recovery 与 Store authority 续切

本节记录同日追加的、只存在于 committed tree 的纵切。主工作目录仍包含其他并行迁移改动，因此所有最终计数均来自新的隔离
Codex worktree，不以主目录的 dirty state 作为通过依据。

- Provider response recovery：`7f4391a00`、`f57d47902`、`124405ffa` 增加严格的 stored response retrieve projector、Attempt
  lease-fenced provider checkpoint 和 retry lineage。已知 provider response ID 时，pending/reclaim/retry 继续 GET 同一 response，
  不重复 POST；digest、model、Attempt lease 和 terminal projection 均 fail closed。这个 durable recovery authority 当前只落在 TS
  Worker/Store 路径；Rust reference 仍没有等价的跨进程 response retrieve authority，因此这里不声明 Rust/TS 完全 parity。
- Tool Approval replacement：`45923ab33`、`ebfdeebf5` 增加跨 Action 的原子 supersede、旧 approval `action_replaced` 终态、
  新 approval/work item/outbox/event 同事务提交，以及 expiry 的有限数值预校验。InMemory、SQLite、PostgreSQL conformance 已覆盖；
  当前仍是 Application/Store 内部 authority，尚未接入 production Worker caller 或新增公共 API。
- Native filesystem read staging：`4aad924c0` 增加 canonical relative components、共享 TS/Rust fixture 和 Unix `openat` +
  `O_NOFOLLOW` stable-handle 的 UTF-8 bounded read primitive，同时约束 byte/envelope 上限并复核 Workspace incarnation。该 capability
  在 Windows 明确 unavailable，且尚未由 Device Hello advertise、Native connection dispatcher、Gateway 或 Worker 路由；它不是已开放的
  产品能力，也没有让 epoch permit 跨 blocking I/O 持有。
- Automation authority：`72619f1b3..9ade2fe36` 提交 tenant/space-scoped Application port、InMemory/SQLite/PostgreSQL
  authority、schema、receipt 与 conformance。生产逻辑已从 4k/6k 行聚合 Store 抽离：InMemory 366 行；SQLite 480/117/44 行；
  PostgreSQL 483/405/256/11 行，均低于 500 行。Automation 仍保持 manual-only；scheduler、Control/UI production admission
  不是本纵切的完成项。
- Workspace Store composition：`bbeef7a17` 建立 `DomainStore` 的强制 `WorkspaceOperationStore` 与 space-scoped Thread port；
  `5f8f730da`、`faa78c5b9`、`1f15a5436` 将已有独立 Workspace authority 以薄转发接入 InMemory、SQLite 和 PostgreSQL，
  并提交 SQLite v21 → v23 migration 和 conformance 注册。没有把 Workspace 业务判断重新塞回聚合 Store。
- clean-tree Gate 首轮据此找出 3 个真实回归：Automation Message rollback correlation 的 InMemory/SQLite 两处失败，以及一条仍把
  SQLite schema 写死为 v20 的旧测试。`751e59f92` 将 `automation_invocation` 纳入 canonical message-backed / instruction-boundary
  语义并校验 Message/history origin；`7c4ca001f` 改为跟随当前 schema 并验证 Provider/Automation tables 只迁移一次。

最终 clean-tree 复验对象为 commit `7c4ca001fa0076cba2512742d2f75be587c81615`、tree
`addcadd9b0fa3f1ae6cbeeaabf2eeeec7f993c93`。7 个 TypeScript package typecheck 全部通过；测试结果如下：

| 包              |   Tests |    Pass |  Fail | Skipped |
| --------------- | ------: | ------: | ----: | ------: |
| Contracts       |      70 |      70 |     0 |       0 |
| Domain          |      80 |      80 |     0 |       0 |
| Agent Kernel    |      20 |      20 |     0 |       0 |
| Agent Responses |      33 |      33 |     0 |       0 |
| Application     |     112 |     112 |     0 |       0 |
| Store           |     312 |     267 |     0 |      45 |
| Runtime Worker  |     169 |     168 |     0 |       1 |
| **合计**        | **796** | **750** | **0** |  **46** |

46 个 skip 全部来自未配置 `CREWON_TEST_POSTGRES_URL` 的条件测试，未计为通过。Rust focused 的
`crewon-device-protocol`、`crewon-device`、`crewon-device-runtime` 三条 `just test -p` 命令均以 0 退出；未运行仓库级完整
`just test`。隔离 worktree 初始/最终均 clean，`git diff --check` 通过，`pnpm install --frozen-lockfile` 前后 lockfile SHA-256
均为 `934cc8f3ccf553b7e5f890818df3a42827e2d78de29a3380f50f3521f0298fa5`。

## AR-031、Approval recovery 与 Native read foundation

本节记录后续三个独立 Codex worktree 的最小可审阅纵切，以及它们合入真实 dirty 主工作树后的交叉验证。它们都直接落在现有
`codex/agent-runtime-migration-20260811` 分支，没有创建新的产品项目或复制一套实现。

- AR-031 narrow parity：`86c815345` 让 Responses decoder 解析可选 boolean `end_turn`，并让 TS Kernel 在
  `storeResponses=false`、completed response 无 output/tool/checkpoint 且 `endTurn=false` 时，在同一 Turn/Segment 继续第二次 sample。
  首次 usage 保留在 RunState 累计 authority 中，第二个 response 才提供 terminal output；这不是 sampling retry。为避免循环 retrieve
  同一个 stored response，只要 request/response/completed 带 checkpoint，或第一段出现 output/tool item，就分别以
  `model_end_turn_false_stored_response_unsupported` / `model_end_turn_false_output_unsupported` fail closed。迁移矩阵因此把 AR-031
  标记为 `PARTIAL`：empty/manual 子场景已对齐，stored checkpoint chain 与 output/tool 分支仍未完成。
- Tool Approval recovery/adoption：`983ebfc07`、`ff5041a3e`、`40cd02a4c` 只在 Worker 恢复/接管
  `waitingApproval` 时寻找同一 Run/Work Item 已有 durable prepared receipt。发现 canonical ActionIntent 已变化后，调用既有
  Application/Store replacement transaction，原子 supersede 旧 approval、安装新 required approval、追加 Event/Outbox 并继续 hold
  Work Item；Provider/Device side effect 保持 0。相同 action 稳定 replay，不创建第三个 approval。正常顺序 Worker 路径不会制造
  replacement candidate，本纵切也没有增加公共 Control API。
- `workspace.read_file.v0` durable foundation：`bc9cefa6a..cf121f3b3` 增加独立 strict command/event/ACK contract 和
  SQLite journal authority。accepted 固定 sequence 1，completed/failed/canceled/unknownOutcome 固定 sequence 2，ACK cumulative；事件绑定
  execution、workspace/incarnation、connection epoch、receipt 和 canonical signed-command SHA-256 digest，completed content digest 由
  journal 重算。TS parser 通过注入同步 digest 函数保持 browser-neutral，shared fixture 冻结 TS/Rust wire 与时间格式。
- journal schema v3 对 command/event/ACK fingerprint 与 command digest 强制完整 `sha256:` + 64 位 lowercase hex CHECK；启动 authority
  复核 columns、FK、index table/SQL 与完整 CHECK 形状。真实 populated v2→v3 migration test 保留 command、accepted、terminal 与 ACK head。
  execution GET、bounded unacknowledged list 都在单一 read transaction 中；分页按 execution ID byte order、`limit+1` cursor 且严格限制
  `1..=100`。backward ACK、早于 event/prior ACK 的时间、same-sequence identity drift 和冗余 `acknowledged_at` 列漂移均 fail closed。
- 这仍是未广告、未路由的基础设施：Device Hello、Native dispatcher/runtime、Gateway admission 和 Runtime Worker 都没有暴露
  `workspace.read_file.v0`。下一纵切必须单独接 dispatcher/runtime/Gateway，并继续维持 stable handle、epoch fence、path-free wire 与
  bounded output 不变量；不能把 journal foundation 记成用户可用能力。

合入主工作树后，6 个 TypeScript package typecheck 全部通过；测试结果如下：

| 包              |   Tests |    Pass |  Fail | Skipped |
| --------------- | ------: | ------: | ----: | ------: |
| Contracts       |      73 |      73 |     0 |       0 |
| Agent Kernel    |      22 |      22 |     0 |       0 |
| Agent Responses |      34 |      34 |     0 |       0 |
| Application     |     116 |     116 |     0 |       0 |
| Store           |     313 |     267 |     0 |      46 |
| Runtime Worker  |     179 |     178 |     0 |       1 |
| **合计**        | **737** | **690** | **0** |  **47** |

47 个 skip 全部来自未配置 `CREWON_TEST_POSTGRES_URL` 的条件测试，未计为通过。Rust focused 验证为
`crewon-device-protocol` 3 / 3、`crewon-device-journal` 20 / 20、`crewon-core provider_end_turn` 1 / 1；后者另有
2759 个非目标测试被过滤。三个独立 worktree 各自通过对应 typecheck/test/scoped fix/fmt，合入后
`git diff --check 1cea8fb76..cf121f3b3` 通过。未运行仓库级完整 `just test`，也没有把缺少本地 PostgreSQL、Windows real-host 或发布签名凭据的
Gate 报告为通过。

## 最终 macOS packaged smoke

- Sidecar staging 使用官方 redistributable Node `v24.18.1`：
  `f480e325ee0ca9cb9eef00b5ca6057a2a104807a1b073f1bc373a55c67facff5`。
- `Crewon.app` 与 updater tarball 已生成。Tauri 命令在 bundle 生成后因缺少 `TAURI_SIGNING_PRIVATE_KEY` 返回 1；没有绕过 updater 签名 Gate。
- 隔离 HOME：`/private/tmp/crewon-packaged-smoke.LxwDwe`。
- 新 bundle 启动后 Control ready 返回 200；Gateway、Device、Worker、Control 四进程均运行，legacy app-server 继续服务尚未迁移能力。
- persisted Device route 从前一轮 epoch 6 推进到 epoch 7；heartbeat 保持同一 connection ID，只延长 lease。
- 使用新 idempotency key `packaged-final-ui-v1` 执行真实 Workspace list：
  `README.md`、`alpha`、`beta`，`status=completed`、`truncated=false`。
- Gateway durable record：accepted sequence 1、terminal sequence 2、resolution `completed`。
- Native journal：同一 execution/epoch 7 的 accepted + completed event，以及 ACK 1 + ACK 2；`acknowledged_through=2`。
- 命令完成后 route 仍为 epoch 7，没有因 heartbeat 或普通命令重连。
- 对 GUI 发送 `SIGKILL` 后 guardian 清理全部 bundle 子进程，端口 3210 与 6176 均释放。

## `workspace.read_file.v0` internal runtime / Gateway 纵切

- Rust Native：`973548e7d..fb7b620c1` 将已有 strict read command 与 stable-handle primitive 接入
  `crewon-device-runtime`。当前 runtime 只在完整 dispatcher/journal/ACK 路径安装后 advertise
  `workspace.read_file.v0`；accepted sequence 1 在 handle acquisition 和文件读取前持久化，潜在阻塞 I/O 在 epoch permit 与
  journal writer transaction 之外执行，terminal sequence 2 先持久化再发布。accepted-only 重启结算为 deterministic
  `unknownOutcome`，terminal replay 只读 journal、不重新读取文件；Hello、reconnect 与 cumulative ACK 同时覆盖 Workspace list 和 read。
- 并发修复：fresh same-execution 的 admission、accepted 与 in-process reservation 现在绑定在同一
  `BEGIN IMMEDIATE` 获胜事务中，避免 replay 把仍在执行的 accepted command 误判为 crash。确定性 barrier 回归证明 admission 只由
  winner 执行一次。
- Gateway：`3b1190165..4b047e6d1` 增加独立 `workspaceRead` execution kind、strict event/ACK、socket session 和 internal
  service。fresh prepare 将 command 与认证得到的完整 device/runtime route fence 一起 canonicalize 并 durable freeze；accepted 与
  terminal receipt/epoch/digest/sequence 均严格绑定，ACK 只在 durable commit 后发送。expired signed command 的 durable replay 使用独立
  transport deadline，caller abort 区分 `notSent` / `possiblySent`。
- SQLite schema v3 与 PostgreSQL schema v4 增加 read authority；SQL adapter 不保留长期可变内存快照。每次 prepare/commit 都在数据库
  transaction 中锁定 execution kind 和当前 record、strict parse、应用 transition、写入并 commit 后才返回。SQLite write failure 会 rollback
  且不留下 phantom authority；PostgreSQL 两个独立 Pool 的 same-command convergence、identity/terminal conflict、跨副本可见性测试已写入
  条件套件。当前环境没有 `CREWON_TEST_POSTGRES_URL`，因此这 7 条 PostgreSQL 条件测试未实跑、不得算作通过。
- Agent Runtime AR-031：`f4912f93b`、`30ee5035c` 为 manual / `storeResponses=false` assistant-only
  `end_turn=false` 增加显式 durable provider-continuation boundary。Kernel 不再把它伪装成 sampling retry；Worker 将本次 completed
  assistant items、Run events/usage、Model History、Thread model state、sample marker 与 Step/Attempt completion 原子提交。每个 sample
  使用独立、完整语义绑定的 idempotency receipt；commit 后进程丢失会从 exact durable history suffix 继续，不重复 sample、usage 或
  assistant Message。InMemory、SQLite 与 PostgreSQL adapter 共用 execution-store conformance；Rust 与 TS 消费同一份三请求 fixture，冻结
  `working`、`still working`、`done` 的历史和累计 usage。`9906618be` 继续补齐 stored-response checkpoint：空的
  `end_turn=false` stored response 以 checkpoint 发起新的 POST，不 retrieve、不消耗 retry budget；stored Tool response 返回 durable Tool
  boundary 与 checkpoint。`59bbdb23b` 进一步让 stored assistant-only output 走同一 durable boundary：completed assistant history、usage、
  provider checkpoint object/digest、Thread continuation、model state 与 `segment.provider_continuation` marker 在单一 Store transaction
  提交。真实文件 SQLite 在 commit 后模拟 crash、关闭并重开 Store；恢复 Worker 只发第二个 POST，携带
  `previous_response_id` 与空 `input=[]`，没有 GET、旧 response 重采样、sampling retry、重复 usage/history/marker 或 phantom Message。
  `23b92761c` 进一步关闭 stored mixed assistant→Tool：Kernel 生成单一 durable continuation boundary，Application/Store 在同一事务中
  按 assistant→tool_call 顺序提交 history、首段 usage、Provider checkpoint object/digest、Attempt、Thread continuation、model state、
  Tool request 与 `segment.provider_continuation` marker；Tool result receipt 沿既有 execution authority exactly-once 结算。commit 前 crash
  不留下 partial authority；commit 后的真实文件 SQLite close/reopen 只执行一次 Tool，并只发送第二个带 `previous_response_id` 的 POST，
  input 为精确 Tool result suffix，无 GET、旧 response 重采样、sampling retry 或重复 terminal Message。广义 AR-031 现标为 `PARITY`。
- Agent Runtime AR-032：`dd22823f3` 增加 Rust/TS 共用的 malformed Provider usage fixture。Rust `crewon-api` 的 HTTP/SSE 与 WebSocket
  复用同一 decoder，在 usage 进入 Session/Goal/budget/compaction 记账前拒绝负 token、负 cached token、`cached > input`、
  `total != input + output` 与加法溢出；TS Direct Responses 对同一组 case 返回 non-retryable protocol failure。fixture 已接入 Bazel
  runfiles，Cargo/Bazel lock 均通过一致性检查。
- Agent Runtime AR-033：`731e43a89` 对齐 Rust 的 optional usage 终态。合法 `response.completed` 在 usage 缺失或显式 `null` 时仍成功完成，
  TS 不再误报 protocol failure，也不伪造零 usage；HTTP/SSE 与 WebSocket 继续复用同一 decoder。Rust/TS shared fixture 同时覆盖两种
  framing policy，Rust `crewon-api` 124/124、TS Agent Responses 38/38 通过。
- Agent Runtime AR-034：`f20ecbcda` 对齐 Rust 对冗余 final output snapshot 的处理。合法 `response.completed` 可缺省
  `response.output`，同时保留 streamed delta、matching `response.output_item.done`、usage、response identity 与成功终态；字段存在时
  仍严格比较 streamed output，不一致继续返回 non-retryable protocol failure。共享 fixture 同时驱动 HTTP/SSE `required` 与
  WebSocket `whenPresent` framing，Rust `crewon-api` 125/125、TS Agent Responses 41/41 与 typecheck 通过。
- Agent Runtime AR-035：`f54488de6` 对齐 Rust 的 failure-first terminal。带可分类 `error` / `incomplete_details` 的
  `response.failed` / `response.incomplete` 可作为首个且唯一 terminal，不要求冗余 `response.created`、`id` 或 `status`；字段出现时仍
  执行 bounded identity、已有 created identity match 与 exact status 校验，`response.completed` 的 created/id/status 严格性不变。
  shared fixture 从实际事件与 decoder 状态比较 category/retryability、history、usage 与 response identity；TS Agent Responses
  `45/45`、typecheck 与 Rust `crewon-api 126/126` 通过。完全缺失 response/error/details 的 generic failure 和其 retry 决策仍未外推。
- Agent Runtime AR-036：审计复现 Rust 接受 `response.created` 的空 `response` object，而 TS 以
  `responses_response_id_invalid` 拒绝。进一步的确定性 Rust fixture 证明其后 text delta、completed item、携带 late id/status/output 的
  completed success，以及 failed/incomplete（覆盖 later id/status 缺失和存在）均可到达对应终态。TS HTTP/SSE `required`、WebSocket
  `whenPresent` framing 现在复现完整矩阵；late completed id 建立唯一 completion checkpoint identity。created/terminal identity 一旦出现
  仍严格 bounded/match，completed status 与 final output 仍严格，duplicate created 继续拒绝，因此不形成 identity/checkpoint/status 旁路。
  Focused evidence：TS Agent Responses `49/49`、typecheck、Rust `crewon-api 127/127`、scoped fix 与最终 fmt 均通过。
- Provider private probe foundation：`c4af42230` 提取 Control→Worker 的认证、有界 transport 与 process-local replay authority。
  Worker 只监听 loopback，以 constant-time bearer 校验、byte-level token/request cap、64 KiB response cap 和 peer-disconnect abort
  保护 secret lease；Control client 限制 loopback HTTP / HTTPS、总 deadline、caller abort、bounded JSON，并核对 Provider、catalog
  revision 与 runtime generation。幂等 coordinator 按完整 actor scope + request fingerprint 合并同 key；in-flight / `possiblySent`
  条目不因 TTL 或容量被淘汰，容量全被不可安全淘汰条目占用时 fail closed，不重复 dispatch。它明确只服务非变更型 probe，不能替代
  跨进程 mutation receipt。独立 worktree focused evidence 为 Runtime Worker `21/21`、Control `15/15`；共享根覆盖层为 Runtime Worker
  `218 passed + 1 PostgreSQL-unconfigured skip`、Control `95 passed + 3 PostgreSQL-unconfigured skip`，两者 typecheck 均通过。
- Runtime Worker read command / client：`78d6bbeec`、`5dc2472a8` 生成并签名 `workspace.read_file.v0`，canonical action digest
  绑定 tenant/space/thread、Run/Step/Attempt/execution、lease、Workspace/Device/Runtime、policy、路径和固定 limits。`8564a679b`、
  `ff96099c9` 增加 strict private Gateway execute/reconcile/cancel client：共享 parser 深校验请求、错误与 terminal receipt，HTTPS/mTLS
  transport 使用有界 body、总 deadline、AbortSignal 和保守 `notSent` / `possiblySent` 边界，cancel 只发送 lease-exact passive reference。
- Gateway private/peer read：`703193010..b6ca8ab8d` 增加 Worker admission、receipt-first execute/reconcile/passive cancel、跨 Gateway
  TLS 1.3 单跳转发和完整 route/epoch/lease/digest/receipt correlation。heartbeat 只延长同一 route fence；caller abort 在 route load、
  verifier、prepare 和发送前边界重复检查，取消不会触发命令 replay。
- 本阶段根工作区统一验证：Contracts `77/77`、Device Gateway `107 pass + 7 PostgreSQL-unconfigured skip`、Agent Kernel
  `23/23`、Application `116/116`、Store `269 pass + 46 environment-conditional skip`、Runtime Worker
  `190 pass + 1 PostgreSQL-unconfigured skip`；对应 package typecheck 全部通过。Rust
  `suite::provider_end_turn::end_turn_false_assistant_items_continue_same_turn` focused reference `1/1` 通过。此前本纵切的
  `crewon-device-journal 21/21`、`crewon-device 30/30`、`crewon-device-runtime 21/21` 证据保持有效。
- 该阶段的能力边界：当时没有增加 Control/public API。command producer 与 production Gateway client 已具备，但尚未由 durable
  Application read-operation authority 在网络发送前原子冻结 reference，也未接入 Agent Tool catalog/Runtime Worker 调度、native bootstrap
  composition 和 packaged read smoke；因此不能只凭该阶段宣告用户可用，后续 production composition 与 packaged smoke 见下一节。

## Packaged `read_file` production composition 与 crash recovery

- `e6e04d142` 补齐 Device Gateway 生产入口缺失的 Workspace Read composition：SQLite standalone 与 PostgreSQL Team 分别使用其
  durable connection-route authority，生产 server 同时安装 Device、Workspace List、Workspace Read store，并复用已实现双接口的 HTTPS
  peer client。route resolver 在每次 prepare 时重新核对 device/gateway/connection/epoch/lease；stale takeover fail closed。
- `64cd9e374` 将 Runtime Worker Workspace Read 幂等指纹绑定到稳定的 `workItemId`、`stepId`、`attemptId`，排除每次 claim 都会变化的
  `leaseId`、`leaseEpoch`、`expiresAt`。因此进程恢复或租约重领不会把同一 Tool execution 误报为
  `workspace_read_file_conflict`。
- 严格 Provider harness `6deda420e` 冻结完整 Tool catalog，只接受 immutable `read_file` 与 server-owned `get_goal`、`create_goal`；
  每轮使用唯一 call/response ID，并验证历史 `function_call` / `function_call_output` 必须完整配对、同一路径、唯一且有界。真实 Provider
  两轮 transcript 分别记录 `toolRequested` 与 25-byte `toolResultObserved`。
- rebuild 后的 macOS `Crewon.app` 在隔离 HOME `/private/tmp/crewon-packaged-smoke.LxwDwe` 完成真实 Turn。epoch 11 的首次尝试 Run
  `019ff1f7-898f-71ec-aedc-f79806ea67aa` 读取 `README.md`，Control Tool receipt 与 Workspace operation 都结算为 `completed`，输出精确为
  `packaged workspace smoke\n`。Gateway durable record 包含 accepted/terminal，Rust journal 包含 sequence 1/2 与 ACK 1/2。
- 对 GUI 根进程发送 `SIGKILL` 后，guardian 清理所有 bundle executable，Control `3210` 与 app-server `6176` 均释放。同一 HOME 重启后
  route epoch 从 11 精确推进到 12，并由新的 connection ID 接管；没有复用旧 route lease。
- epoch 12 下使用新 call ID 和 idempotency key 再执行真实 Turn：Run
  `019ff1fc-17e0-704a-880e-84d324bd1750`、execution `019ff1fc-1a2c-728e-bc87-b9fa7060e34a` 首次尝试完成，
  Worker `attempt_count=1`、`last_error_code=null`。Gateway 为 `workspace_read.accepted` + `workspace_read.completed`，Device journal 的两个
  event 均绑定 connection epoch 12，`acknowledged_through=2`；命令后 route 仍为 epoch 12。
- AR-031 并行 worktree 已阶段集成为 `9906618be`、`b112e22e6`、`d6efadb14`。Control 的
  `segment.provider_continuation` public projection 只暴露 `segmentId`、`sampleIndex`、`throughHistorySequence`，client/audit 两种 view
  一致且不泄漏内部 `segmentSequence`。
- 当前 clean committed-tree 验证（`e2ac35b10`）：Agent Kernel `25/25`、Agent Responses `38/38`、Context `16/16`、
  Application `112/112`、Store `290 pass + 49 PostgreSQL-unconfigured skip`、Runtime Worker
  `213 pass + 1 PostgreSQL-unconfigured skip`、Rust `crewon-api 124/124`，六个 TS package typecheck 全部通过，worktree initial/final
  均 clean 且 HEAD 未变化。此前 Contracts `77/77`、Control API `90 pass + 3 PostgreSQL-unconfigured skip`、Device Gateway
  `109 pass + 7 PostgreSQL-unconfigured skip`、Rust Device `27/27`、Tauri `100/100`。相关 6 个 TS package typecheck 与
  `just bazel-lock-check` 通过；所有 skip 继续按未验证处理。
- 同一 committed HEAD 叠加共享根工作树既有 Automation/space-scoped Store 草稿后，Context `17/17`、Application `116/116`、Store
  `290 pass + 50 PostgreSQL-unconfigured skip`、Runtime Worker `218 pass + 1 PostgreSQL-unconfigured skip`，六个相关 typecheck 仍全部通过；
  集成 AR-031 前后的未提交补丁 patch-id 均为 `ec6ab79d807909163c317460c0b9169505a7f3de`，证明本阶段没有改写该草稿。

## Automation / Provider 公共契约与 self-contained Control composition

- `f13c17835`、`1eb50bc4f` 发布 Automation create/get/list/run-now 的 OpenAPI 与 generated TypeScript，并以严格 parser 冻结
  manual-only、`automaticScheduling=false`、revision/CAS、分页 cursor、prompt byte cap 和 authority-field injection rejection。
  `2a608eb9c`、`5ee90a4b1` 发布只读 Provider Settings snapshot 与非变更型 probe 契约；公共形状不包含
  `runtimeBindingId`、pending proof、credential secret 或 coordinator identity，也没有增加 Provider mutation route。
- `08f12f7de` 完成独立 Control composition：Automation public vertical 连接既有 durable Application/Store authority；Provider GET
  使用 redacted projection，POST probe 使用 mandatory CSRF + Idempotency-Key 和稳定 fingerprint `model-provider-probe.v1:{}`，复用
  in-flight-safe private coordinator。Production policy adapter 保留完整 Automation action/resource discriminated request tuple；standalone
  authorization 与 UUIDv7 generator 同时结构化实现 Automation ports，没有 cast/`any` 绕过。
- standalone paused admission 只在显式 `CREWON_CONTROL_PAUSED_ADMISSION=1` 时启用；production 出现该变量即 fail closed。候选端口可由
  OS 分配，但 readiness 必须投影为具体 `127.0.0.1:<port>`。激活输入只接受精确、可分片的 `activate\n` 且不等待 EOF；错误前缀、
  oversize、截断 EOF、stream error/close、第二条记录和额外字节都会 fail closed，`onInvalid` 最多一次，controller close 会解绑监听。
  进程级测试真实启动 Control candidate，证明激活前只有 exact live/ready GET/HEAD 可访问，其他 JSON/SSE/错误 body 请求均返回脱敏 503；
  stdin 激活后真实 Thread read/create 成功，SIGTERM 正常退出。
- `b7e18fa88` 将 Provider probe foundation 接入 standalone 真实启动入口。Control 环境只接受完整的 Worker origin/token/timeout 组合，
  production 出现任一 ambient route 即拒绝启动；Runtime Worker 使用严格的 standalone/production security mode，Provider
  binding/port/token/endpoint/credential name/secret 必须 all-or-none，bootstrap 与 ambient 同时存在时 fail closed。endpoint 仅允许 HTTPS
  或 loopback HTTP，拒绝 userinfo、query 与 fragment；inspect 只投影非 secret 字段。进程测试从同一 parser-derived 配置启动私有 Worker，
  经过 bearer 协议请求真实 loopback `/v1/models`，并验证 credential 可用且日志/inspect 不泄漏 secret。
- 在提交 `18262b9ce` 的干净 committed tree 上使用官方 Node `v24.18.1`
  (`f480e325ee0ca9cb9eef00b5ca6057a2a104807a1b073f1bc373a55c67facff5`) 完成组合 Gate：Contracts `77/77`、Agent Responses
  `45/45`、Control API `96 pass + 3 PostgreSQL-unconfigured skip`、Runtime Worker
  `214 pass + 1 PostgreSQL-unconfigured skip`，四个 typecheck 全部通过；Rust `crewon-api 126/126`、`crewon-device 30/30`、
  `crewon-device-runtime 21/21`，Tauri `100/100`，`just bazel-lock-check` 通过。合计 709 pass、4 个环境条件 skip、0 fail；Gate worktree
  initial/final 均 clean、HEAD 未变化。该 Gate 是 Provider startup 与 AR-036 合入前的稳定 committed baseline，不外推为后续提交的全树证明。
- Provider startup 与 AR-036 合入主工作层后的最新 focused overlay 回归：Agent Responses `49/49`、Control API
  `103 pass + 3 PostgreSQL-unconfigured skip`、Runtime Worker `220 pass + 1 PostgreSQL-unconfigured skip`，三者在同一官方 Node 24 下
  typecheck 全部通过；Rust `crewon-api 127/127`，共享 AR-036 fixture 在 Rust SSE decoder 中实际执行，`just bazel-lock-check` 无漂移。
  此前同阶段 Contracts `77/77`、`crewon-device 30/30` 与 Tauri `100/100` 证据保持有效，但没有把未在本次 overlay 重跑的套件重复计入
  最新 focused 总数。Tauri nextest 曾报告一条既有 process-output test 为 leaky，但套件退出码为 0；没有隐藏该提示或算作额外通过。
- 对隔离 HOME 中现存 SQLite authority 的复核进一步确认 Workspace list 修复后的三次真实执行：idempotency key
  `packaged-smoke-workspace-list-v2`、`v3`、`packaged-final-ui-v1` 分别在 connection epoch 5、6、7 完成。每次 Control operation
  `status=completed`、结果均为 UTF-8 byte order 的 `README.md`、`alpha`、`beta` 且 `truncated=false`；Gateway 均有 accepted + terminal，
  Rust journal 均有 sequence 1/2 与 ACK 1/2、`acknowledged_through=2`。后续重启将 persisted route 推进到 epoch 12；当前 bundle
  子进程均已退出且端口 3210/6176 已释放。

## AR-037 terminal cutoff 与 MCP mutation receipt gate

- `fb6eab811` 关闭 Rust transport 自身的不一致：HTTP/SSE 原先在 `response.failed` / `response.incomplete` 后暂存错误并继续读取，
  异常 Provider 随后发送 `response.completed` 时甚至可能转为成功；Responses WebSocket 与 TS decoder 则在首个 failure 立即终结。
  现在 Rust HTTP/SSE 同样以首个分类错误为 cutoff，保留原 retry/category，后续第二个 failure、output、usage、metadata、identity、
  checkpoint 与 completed 均不可见。`AR-037-responses-post-terminal` shared fixture 同时驱动 Rust HTTP dispatch 与 TS
  `required` / `whenPresent` framing；依赖 legacy failure→completed 的异常 HTTP stream 会从成功变为首个错误，这是有意的兼容性修正。
- `85034322f` 为 AR-019 intentional redesign 落地 mutation receipt gate，但没有恢复 legacy “server opt-in 即并发 mutation”。只有显式
  `mutation + reconcilable` policy 且 MCP client 提供 execute/reconcile/cancel provider contract 时才进入 catalog，并强制 serial；未审计 Tool
  与没有 reconciliation contract 的 mutation 继续不可用。Tool Broker 的完整 policy validator 成为 read-only/mutation 共用唯一入口，
  configured policy 在 admission 时验证并深拷贝；provider 收到原始 MCP tool name、稳定 execution identity 与完整已验证
  `ToolExecutionCommand`，包括 action digest/intent、approval proof 和当前 lease。adapter resolution 使用 exact-shape、bounded receipt 和
  result parser，不能注入额外 authority 字段或绕过 output cap。
- Runtime Worker 继续复用既有 durable `tool_execution_receipts`，没有新增平行状态机。真实文件 SQLite 在 Provider mutation 已完成、
  本地 receipt commit 前模拟进程丢失并 close；重开 Store 和新 MCP runtime 后只以相同 execution identity 调用 reconcile，`executeCount=1`，
  最终 Tool result 按原 call order 唯一提交。外部 policy 对象和 `executionPolicy()` 返回快照的后续修改均不能改变 runtime authority。
- 最新主工作层 focused Gate 使用官方 Node 24：Tool Broker `12/12`、MCP Runtime `5/5`、Agent Responses `51/51`、Runtime Worker
  `221 pass + 1 PostgreSQL-unconfigured skip`，四个 typecheck 全部通过；Rust `crewon-api 129/129`，`just bazel-lock-check` 通过。
  合计 418 pass、1 个环境条件 skip、0 fail。原 `runtime-worker.test.ts` Automation 草稿在集成前后 stable patch-id 均为
  `892bc077d80d3488046a317b67486aa6c465f7c5`，证明本阶段没有改写该并行工作。
- 本阶段只提供严格 adapter contract、admission 与 durable recovery 证据；生产级 remote MCP mutation transport、真实远端 receipt service、
  plugin/skill composition 与跨网络 crash/timeout/partition 验收仍未实现，不能据此宣称 remote mutation 已对用户开放。AR-037 WebSocket
  证据由 shared dispatcher 与既有 `run_websocket_response_stream` 的 `Err => return` 组合构成，尚未新增完整异常 Provider socket harness。

## 尚未关闭的完整迁移 Gate

- Windows real-host：stable directory handle / UTF-16 / reparse rejection、Job Object 全树清理、NSIS 与 packaged smoke。
- Linux real-host 与 macOS Intel：process containment、secret store、sidecar target 与完整 bundle acceptance。
- updater 私钥、Apple signing/notarization、DMG 与发布凭据。
- 本轮没有 PostgreSQL URL，因此 56 个 Store / Gateway / Worker / Control 条件测试没有被报告为通过；Team 仍需真实 Identity/PIM、
  跨副本 quota/rate、backup/restore、network partition/chaos 与 rolling compatibility 证据。
- Workflow/Office/Human Gate、Memory、Resource/PIM、远程 mutation MCP/plugin/skill、Config 与 legacy app-server cutover 仍需后续纵切。
- Rust core 只运行了与本轮变更对应的 focused suite；仓库级完整 `just test` 仍须按仓库规则单独获准后运行。

因此本轮证明的是基础 Agent P0 completed-item 边界和 Native Workspace 四进程纵切已在当前分支落地，而不是完整产品迁移或生产发布已经完成。
