# W2-08 Verification

状态：Stage A/B/C/D 默认关闭 composition 与 hermetic vertical 已完成；Wave 2 release Gate 仍 Red，因为完整 workspace `just test` 尚未获得用户授权。此前不得开启生产 Provider 开关，也不得进入 W3-01 Cloud Agent 原子切换。

## 已完成的生产语义

### Provider Run Supervisor

- `CREWON_PROVIDER_CONTROL_ENABLED` 独立且默认关闭；启用时要求已准备的 Agent Platform runtime 与 sqlite State，配置缺失或非法立即失败。
- Worker outbox 只消费 `dispatchAttempt`、`cancelAttempt`、`reconcileAttempt`；Authority enqueue/retry/resume 决策不被误消费。
- defer/delivered 都绑定 observed attempts CAS；Provider Run poll/backoff、non-terminal restart recovery、terminal final-claim audit 与 shutdown cancellation 均持久化。
- 每 tick 和 page 都有硬上限；当前生产外部操作 timeout 30 秒、并发硬上限 1，失败 durable backoff 为 1..300 秒。

### Durable Thread Execution Context

- migration 0048 与 State runtime 保存 metadata/reference only 的 owner actor/tenant/space、Conversation Workspace、exact ordered Resource Binding revisions；不保存 root path、Secret、token 或 prompt。
- `thread/start`/`thread/fork` 在生命周期内建立首次 authority；update RPC 只能修改既有 context，不能认领历史 thread。
- resume/fork/update/settings/inject/steer/interrupt 均执行 owner authorization；start/fork 失败回滚，delete 清理，archive/unarchive 保留。
- 每次投影和执行重新读取 active binding，并校验 revision、owner、workspace key/scope/scopeId；revoke 或 drift fail-closed。

### Dynamic Tool 与 UI 原子切换

- exact MCP Tool/Knowledge Binding 被投影为 server-owned `crewon_binding_*` Core Dynamic Tool；Agent、Skill、MCP Server、Workflow 不伪装为当前会话可执行工具。
- Provider connection projection 现完整映射合法的 `remoteTool` / `remoteKnowledge` capability；纵向 Harness 发现并修复了此前将两者误判为 incompatible、导致真实 Tool/Knowledge Provider 无法连接的逻辑漏洞。
- Provider namespace 在 app-server 内执行并直接提交 `DynamicToolResponse`；未知/撤销/重复/timeout/unknown outcome 不回退浏览器。非 Provider dynamic tool 继续走原通用客户端协议。
- Provider event dispatch 使用独立 task，避免 30 秒外部超时阻塞事件监听；turn 完成或无 Provider spec 时清理内存 turn authority。
- UI `App.tsx` 已接入 `ProviderResourceSession`、恢复控制器、picker 与 composer tag；binding 只对 owning conversation 可见，切换线程不串用。
- 旧 `pimDynamicTools.ts`、interceptor、executor 和测试已删除；扫描 `pimDynamicTools|executePimDynamicTool|isPimDynamicToolCall|/api/v1/mcp/tools/.*/call|/api/v1/knowledge/search` 为零。
- 旧 `agentPlatform/chat`/session/cancel 调用点仍有 44 处，属于 W3-01 Cloud Agent 兼容链，当前任务没有误删或切流。

## 架构与规模复核

- 新 platform-control 请求逻辑移入 `message_processor_platform_control.rs`（223 行）；`message_processor.rs` 只保留窄 dispatch/composition，避免继续堆领域规则。
- Provider/Resource/Thread authority 的重型 async 分支在中心 match 边界使用 boxed future。该修复把 `thread/start` tracing Harness 从稳定 4MB stack overflow 恢复为同栈 1/1 Green，没有放大测试栈掩盖问题。
- `App.tsx` 为 898 行，低于前端 900 行架构阈值；Provider Tool server、Thread context runtime 均低于 500 行。
- Cargo workspace 新 crate/dependency 已执行 `just bazel-lock-update` 与 `just bazel-lock-check`；Bazel lock 无漂移。
- `git diff --check` Green；旧 PIM execute 调用点为零。

## Harness 证据

- State：214/214 Green。
- app-server protocol：248/248 Green，stable schema 已重生成。
- Agent Platform Provider adapter：61/61 Green。
- app-server transport：136/136 Green（1 项首次 timing retry 后通过）。
- app-server hermetic vertical：1/1 Green。该单链使用真实 request processors、temporary State、production RS256 Provider client 与 Fake Provider，完成 connect/read/list/resource-read/bind、Thread authority exact binding、dynamic manifest projection、read-only knowledge execution、journal completion，并断言请求不含 workspace root/private key。
- app-server：1131 项批量运行 1130 passed；新增 vertical 与所有 Provider/Thread/Dynamic Tool/Workspace/Authenticated WebSocket 链均通过。唯一未在并发批量中通过的是既有 Unix 第二次 Ctrl-C 强制退出时序项，隔离复验 1/1 Green；另有 4 项由 nextest 自动 retry 后 Green。此前发现的中心 async future 4MB stack overflow 已通过模块拆分/boxed dispatch 修复，原 stack test Green。
- Core 本次直接相关链路：hidden dynamic tool、tool search、deferred route、sqlite resume 共 4/4 Green。一次高并发 core 包运行因本机事件等待争用得到 2404 passed / 293 timeout failures，不能计作完整包 Green，也没有被误报为功能回归。
- CrewON UI：222 test files / 1271 tests Green；`pnpm lint` Green；production `pnpm build` Green，只有既有 chunk-size warning。
- Provider picker/composer snapshot 已更新并审阅；知识库/MCP Tool tag 无重复文本与换行回归。
- scoped lint/fix：`crewon-app-server`、`crewon-core`、`crewon-app-server-protocol`、`crewon-state`、`crewon-app-server-transport`、`crewon-provider-agent-platform` 均 Green；随后执行最终 `just fmt`，未在 fix/fmt 后重跑测试。

## 尚未满足的 Gate

1. 完整 workspace `just test` 尚未运行；仓库规则要求在 core/protocol 公共改动后先获得用户授权。当前相关 package/targeted/vertical evidence 已完成。
2. 登录后的真实 CrewON 页面视觉验收仍未验证：本地浏览器被登录门禁拦截，未猜测或绕过凭据。
3. 真实部署 key provisioning 与真实云模型 smoke 属于 R1/W3-01，尚未完成；旧 Cloud Agent 切换点、删除边界和 rollback fence 已冻结在 `../W3-01/`，但未执行。

## 结论与下一步

Stage A/B/C/D 的代码边界、安全语义、UI 原子删除、默认关闭 composition 与单链 hermetic vertical 已完成；没有浏览器 Secret/直连 fallback，也没有把 Cloud Agent 旧链误切到新权威。Wave 2 release Gate 继续保持 Red 的唯一代码库验收原因是完整 workspace `just test` 尚未获授权；其通过后可把 Wave 2 Gate 改为 Green。登录后视觉验收与 R1 真实 key/model smoke 仍是生产切换前独立边界，W3-01 当前不解锁。
