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

## 尚未关闭的完整迁移 Gate

- Windows real-host：stable directory handle / UTF-16 / reparse rejection、Job Object 全树清理、NSIS 与 packaged smoke。
- Linux real-host 与 macOS Intel：process containment、secret store、sidecar target 与完整 bundle acceptance。
- updater 私钥、Apple signing/notarization、DMG 与发布凭据。
- 本轮没有 PostgreSQL URL，因此 56 个 Store / Gateway / Worker / Control 条件测试没有被报告为通过；Team 仍需真实 Identity/PIM、
  跨副本 quota/rate、backup/restore、network partition/chaos 与 rolling compatibility 证据。
- Workflow/Office/Human Gate、Memory、Resource/PIM、远程 mutation MCP/plugin/skill、Config 与 legacy app-server cutover 仍需后续纵切。
- Rust core 只运行了与本轮变更对应的 focused suite；仓库级完整 `just test` 仍须按仓库规则单独获准后运行。

因此本轮证明的是基础 Agent P0 completed-item 边界和 Native Workspace 四进程纵切已在当前分支落地，而不是完整产品迁移或生产发布已经完成。
