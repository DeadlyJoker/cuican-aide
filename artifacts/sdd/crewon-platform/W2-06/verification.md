# W2-06 Verification

状态：P0-P4 Green，W2-06 独立组件 Gate 完成。生产 `App.tsx` 接线、旧浏览器直连路径删除和 Office/Workflow/Experts scope 组合仍归 W2-08。

## Discovery evidence

- 当前 `agentPlatformClient.ts`、`agentPlatformCatalog.ts`、`pimDynamicTools.ts` 仍允许浏览器经 `/agent-platform-api` 读取或调用云资源；它们不能成为终态 Provider/Resource authority。
- 当前 `App.tsx` 把 Skill/MCP/Knowledge 选择映射为 `agent-platform://...` client-only mention，未调用 `resource/bind`，因此标签不代表 durable binding。
- `ComposerResourceTags` 已支持 file/folder/image/knowledge/mcp/skill，可复用视觉与移除交互；W2-06 不新增图片入口。
- AppServerClient 已在 initialize 时 opt in experimental API，但 vendored TypeScript 默认为 stable-only；需要独立、最小、生成式 experimental platform overlay。
- W2-04 没有 owner-scoped binding list/read。当前页面可在 app-server 重启后利用内存中的 exact selection 重连/重绑；浏览器刷新后必须显示真实未绑定，不能靠 localStorage 伪造。

## P0 evidence

- 新 Harness 首次失败于 `ClientRequest.ts imports ./v2/ResourceReadParams`，且目标文件未生成。
- 根因是无用 import 过滤器用 substring 判断：`McpResourceReadParams` 使 `ResourceReadParams` 被误判为仍被使用。
- 修复改为完整 TypeScript identifier 边界匹配；稳定生成后不含 `provider/connect`、`resource/read` 或实验 Params import。
- `just test -p crewon-app-server-protocol generated_typescript_relative_imports_resolve`：1/1 Green。
- 最终 `just test -p crewon-app-server-protocol`：246/246 Green。

## P1 generated overlay evidence

- `typescript-experimental-platform` 由 Rust `ts-rs` 递归生成，最终 37 files / 268 lines，只包含 Workspace、Provider、Resource control-plane DTO 与依赖。
- overlay 有独立 index、generated header、fixture parity、relative import completeness 和 stable non-leakage Harness；stable `ClientRequest` 未新增实验方法。
- App-server README 与 CrewON UI 独立 path alias 已更新；没有复制完整 869 文件 experimental schema，也没有手写 Params/Response。

## P2 client and recovery evidence

- `ProviderResourceClient` 用 generated method map 限定 workspace/list-bind、provider/connect-read、resource/list-read-bind-unbind；AppServerClient 只持有窄 transport adapter。
- FakeWebSocket Harness 验证 8 个 RPC 经已初始化 websocket 发出，request 不含 actor、tenant、space、Credential、endpoint、root path、token 或 Secret。
- `ProviderResourceSession` 与 support 模块分别低于 500 行；状态机有 generation barrier，旧连接迟到 response 不会覆盖新状态。
- pagination 单页 100、最多 20 页/1000 项；重复 cursor 或 provider etag gap 自动从首游标重读一次，第二次异常 fail-closed。
- reconnect 使用页面内 exact intent 获取新的 Workspace bindingId、Provider connectionId 和 Resource bindingId；不使用 localStorage。授权撤销清空 authority projection，只保留可重试的非敏感 intent。
- browser storage Harness 将 localStorage/sessionStorage 设为任意访问即抛错，完整 catalog+bind 仍 Green，证明它们不参与 authority 或恢复。
- exact read/bind 校验 Resource revision、Provider etag、Workspace scope、binding mode 与 active status；不支持的 capability 在调用前拒绝，服务端仍是最终权威。

## P3 UI and snapshot evidence

- `ProviderResourcePicker` 仅展示真实 providerId、resourceId、revision、connection/binding/capability 状态；无 display name 时不造假。
- 快照覆盖真实列表+active binding、恢复中、不可用、capability unavailable；已人工检查。
- `providerResourceComposerTag` 只映射 Skill/MCP/Knowledge，Agent/Workflow 返回 null；没有 `$resource` 文本或换行注入，文件/文件夹和图片粘贴语义未改。
- W2-08 接线输入为 `ProviderResourceSnapshot + selectedResource`，输出为 select/bind/unbind/retry callbacks；scope/workspace context 由调用方提供，组件不拥有 authority。

## P4 verification

- `pnpm --filter @crewon/ui test`：222 test files / 1270 tests Green。
- `pnpm --filter @crewon/ui build`：Green；仅报告既有 bundle chunk size warning。
- `just test -p crewon-app-server-protocol`：246/246 Green。
- `just fix -p crewon-app-server-protocol` 与 `just fmt`：Green。
- 完整 Rust workspace `just test` 未执行，因为仓库规则要求用户明确授权。
