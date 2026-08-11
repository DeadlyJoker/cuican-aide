# Agent Runtime 与 Native Workspace 集成证据

日期：2026-08-11  
分支：`codex/agent-runtime-migration-20260811`  
状态：本纵切已集成并验证；完整迁移仍在进行中

本文只记录当前分支可复现的集成证据，不替代 `ws1-implementation-status.md`，也不把本机 macOS 结果外推为 Windows、Linux、Team 或生产发布完成。

## 本轮落地范围

- 基础 Agent Runtime 对齐了缺失 `response.completed` 时的 completed assistant / Tool item history boundary。
  Rust integration 直接断言第二次 `/responses` 请求；TS Kernel、Responses transport 与 durable Worker 共用 bounded fixtures。
  completed assistant 的 Rust observable 与 TS durable final Message 是已登记的 intentional projection redesign；混合 assistant + Tool
  在 TS 侧会在任何 Tool 副作用前 fail closed，不再被笼统标成 full-trace parity。
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

| 层 | 结果 | 说明 |
| --- | ---: | --- |
| Agent Kernel | 20 / 20 | completed assistant / Tool、mixed fail-closed |
| Agent Responses | 28 / 28 | HTTP / WS、completed item、fallback |
| Rust core focused | 4 / 4 | `stream_no_completed`，828 个无关 case 过滤 |
| Contracts | 69 / 69 | typecheck、test、license、generate-check |
| Application | 115 / 115 | Workspace command/query/delivery authority |
| Device Dispatch | 37 / 37 | signer、executor、client、certainty |
| Store | 263 passed、46 skipped | SQLite/migration/conformance通过；本轮无 PostgreSQL URL |
| Device Gateway | 92 passed、6 skipped | local/TLS/peer/session/receipt；PG 条件测试跳过 |
| Runtime Worker | 168 passed、1 skipped | Agent + Workspace private server；PG 条件测试跳过 |
| Control API | 89 passed、3 skipped | public Workspace routes/SSE/client；PG 条件测试跳过 |
| Native Rust crates | 58 / 58 | protocol 3、journal 14、device 27、runtime 14 |
| Tauri | 99 / 99 | strict Clippy 通过 |
| Staging config | 13 / 13 | sidecar manifest、Node/native probes |
| CrewON UI | 1802 / 1802 | 288 个 test files；lint 与 production build 通过 |

Workspace UI 另在只含 committed `HEAD` 的独立 `git archive` 中验证：9 个 focused files、125 tests、lint、production build 全部通过。
该 Gate 暴露并修复了对未提交 Contracts `eventSequence` 扩展的隐式依赖；Workspace Thread authority 现在只消费 canonical
`GetThreadResponse.thread` 的 identity、revision 与 status。

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
