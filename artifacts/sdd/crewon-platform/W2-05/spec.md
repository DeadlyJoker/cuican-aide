# W2-05 Specification: Dynamic Tool Router

状态：Provider-only v1 路由、准入、执行契约、State-backed journal/Audit、CrewON Provider v3 客户端/执行器、Agent Platform Tool/Knowledge v3 服务端，以及 Provider Artifact 精确下载与本地导入均已 Green。当前 Provider v3 不声明可下载的本地 MCP 包或 `localSnapshot/localFork` capability；因此本地 MCP 不再作为 W2-05/W2-08 的伪前置，继续沿用既有静态 `McpConnectionManager` 路径。只有未来出现真实的不可变 package/download 产品需求时，才单独建立 Local materialization SDD。

## 1. 用户结果与真实入口

- app-server 根据服务端 Resource Binding 选择唯一执行位置；UI 不能声明位置、Credential、argumentsHash、Provider namespace，也不能执行云资源。
- Read-only 通过 Policy Gate 后执行；写操作或外部副作用必须消费与当前参数完全一致的 Approval。`toolCallId` 不重复产生副作用，超时、未知结果、revoke 和 revision drift 不 fallback。
- Result 只以 bounded 内容或 Artifact/Payload reference 回到会话；Audit 不保存 raw arguments/result、Secret 或无限正文。
- 既有本地 MCP 的唯一调用入口仍是 `McpConnectionManager::call_tool`，但它不是 Provider Dynamic Resource Binding。当前 `pimDynamicTools.ts` 的浏览器 `pim` namespace 和旧 Tool/Knowledge POST 只能在 W2-08 原子切换时删除，不能成为服务端 fallback。
- W2-04 binding 已固定 owner/workspace/connection/exact resource/mode/location/digest/status/revision/hash；W1-08 Action Digest 与 move-only authorization、W1-09 metadata-only Audit 可直接复用。

## 2. Discovery 修订：Provider v1 闭环，Local 独立延期

### 2.1 Provider Tool/Knowledge v3

CrewON 侧已实现 strict `remoteTool/remoteKnowledge` discovery、exact manifest、RS256 单次 delegation、`dynamicActions:execute`、closed outcome、Artifact read client 和 digest-verified local importer。Agent Platform 已在独立、默认关闭的 `PROVIDER_DYNAMIC_ENABLED` production composition 中实现以下闭集；关闭时 descriptor 保持 Agent-only，不能半声明能力：

1. closed `remoteTool/remoteKnowledge` capability；
2. exact、可重读的 McpTool/KnowledgeBase revision 与 bounded execution manifest；
3. schema、side-effect classification 和 revision digest；
4. exact resource/operation/Credential revision/actor/tenant/space 的短期 delegation；
5. 幂等 callId、timeout/unknown/error union、Provider audit；
6. 与 CrewON canonical fixture 完全一致的服务端 contract、授权/幂等/审计 Harness；
7. Provider Artifact exact read/download，使 CrewON 能校验 digest 后导入本地 Artifact Store，而不是把 Provider URL 或正文直接透传到会话。

Agent Platform 只发布经过显式授权注册的 immutable MCP Tool/Knowledge revision；不自动把旧表中的 mutable row 声称为 Provider resource。显式 registrar 已进入 production composition，后续资源生命周期可以调用；旧 URL、discovery delegation、latest resource 和 user access token 仍禁止 fallback。

### 2.2 Local materialization 不属于 v1 Gate

W2-04 当前拒绝 `localSnapshot/localFork`，Provider v3 descriptor 也只声明 Provider execution。`McpConnectionManager` 虽能列出当前/缓存 `ToolInfo` 并通过 `(serverName, rawToolName)` 调用，但该快照只证明当时看到的 schema，不能证明重启后相同名字仍对应相同可执行实现；现有 manager 也不暴露 executable/package revision、ETag/source digest 或 Credential revision provenance。仅持久化 locator + schema digest 会产生 silent implementation drift，继续禁止落地。

本期没有“把云 MCP 下载到本地执行”的真实产品契约，也没有可消费的 package/download API。为避免构造不可达的基础设施，W2-05 v1 明确只支持 Provider Tool/Knowledge；动态 Router、Credential resolver 和 durable claim 对 `LocalNode` 全部 fail-closed。既有配置型本地 MCP 不受影响，仍走静态 MCP 路径，不进入 Provider Binding、Provider journal 或 `crewon_binding_*` namespace。

未来只有在产品提供真实的本地包交付需求后，新的独立 SDD 才允许引入以下 server-owned attestation/materialization：

1. source identity 与类型（内置、content-addressed package 或可提供不可变 revision 的远端 MCP）；
2. executable/config 的 exact sourceRevision + sourceDigest，不能只 hash Tool schema；
3. raw server/tool locator、Tool schema digest 与 source attestation 的原子关联；
4. Credential/permission provenance 与 revision，不保存 Secret；
5. restart 时重新验证 source、Credential 和 locator，任一 drift/revoke 都令 binding 不可执行；
6. 只有上述证明成立后才允许写入 `localSnapshot/localFork + LocalNode` binding。

禁止从 UI 参数、Resource ID 约定、Workspace 路径或当前进程中的名字临时解析 locator。

## 3. 唯一路由矩阵

| Resource | Binding | Location | Adapter |
| --- | --- | --- | --- |
| McpTool | RemoteReference/ProviderManaged | Provider | Provider Tool，v3 Gate 后 |
| KnowledgeBase | RemoteReference/ProviderManaged | Provider | Provider Knowledge，v3 Gate 后 |
| 其他 | 任意 | 任意 | Incompatible，无 fallback |

`McpTool + LocalSnapshot/LocalFork + LocalNode` 不属于 v1 矩阵，直接 Incompatible；不能用测试 target、UI 参数或当前 MCP 名称绕过。

McpServer 只是目录资源，不直接执行；Knowledge 第一版只有 bounded `search`。

## 4. Server-owned registration

- namespace 固定为 `crewon_binding_<binding UUID without dashes>`，tool name 固定 `call/search`；冲突拒绝整个 batch，不覆盖。
- registration 固定 bindingId/revision/hash、ResourceRef/digest/location/operation/schema digest/side effect。调用只接收 Core 的 callId/namespace/tool/arguments；客户端 tool 不得覆盖 reserved namespace。
- schema、description、单项/总 bytes 和 Tool count 都有硬上限。W2-08 注入 Core 时必须使用 typed `ContextualUserFragment`，执行 >1K token P0 review 和 10K token hard cap。

## 5. 执行协议

1. `(namespace, tool)` 解析唯一 registration；按 bindingId 重读 State，校验 owner/workspace/status/revision/hash。
2. 从当前 connection/materialization 重解 Credential 和 adapter target；Provider 路径用完整 server-derived `RequestIdentity` 重验 authenticated principal、fresh identity mapping、固定 scope 集、active Grant、connection 与 revision，revoke/expiry/authority drift 拒绝。
3. 用真实 arguments 和 server target 构造 ActionIntent；read-only 可立即授权，其他返回 ApprovalRequired，执行前再次 verify move-only authorization。
4. journal 原子 claim `toolCallId + actionDigest + bindingRevision`；same duplicate 不重放，different digest conflict。
5. 只调用矩阵选中的一个 adapter。error、timeout、unknown 均不试另一个 location；journal/Audit 只存 bounded metadata，超限结果先进入 Payload/Artifact。

### 5.1 P2b execution/completion contract

- Credential resolver 返回由服务端构造的 snapshot；同一 snapshot 同时生成 Policy `CredentialBinding`、写入 claim 的 credentialId/revision，并随 move-only AuthorizedCall 交给唯一 adapter。claim 还冻结 actor/tenant/space/session/trace、Conversation thread/turn、Workspace scope、accessDecisionId 与 exact approvalId；禁止 adapter 从 UI 或 latest connection 重新猜 authority。
- AuthorizedCall 只能被 dispatcher 消费一次。Provider request 只包含 pinned connection/resource 与 exact claim metadata；v1 dispatcher 只有一个 Provider executor port，没有 Local 分支和 fallback 分支。
- adapter outcome 是 closed union：Succeeded、Failed 或 Unknown；router hard timeout 总是映射 Unknown。terminal completion 必须消费 claim，并由 State adapter 原子完成 journal transition 与 metadata-only `ExternalAction` Audit；Fake journal 只保留为 kernel Harness，不能进入 production composition。
- inline result 最多 16 项、总序列化大小 32 KiB、单段文本 16 KiB；图片只允许 bounded raster data URL，其他图片与更大正文必须先持久化为 exact ArtifactRef。结果 metadata 只保存 item count、byte length、digest 或 ArtifactRef，不保存正文。

### 5.2 P3 durable journal/Audit contract

- `0046_dynamic_tool_execution_journal` 冻结 call/action、完整 actor/tenant/space/session、trace/span、Conversation、Workspace binding、Resource binding/connection/protocol/kind/revision/location、Credential、Provider identity binding id/revision + subject/tenant/space、operation 和时间；不保存 raw arguments/result/Secret。
- claim 在 `BEGIN IMMEDIATE` 内重验 hash-bound active binding、connection、live Provider grant 与 exact fresh identity mapping；相同 `callId + actionDigest + binding/credential/identity revision` 返回原 claim，不重放；其他同 callId 输入 conflict。完整 authority hash 仍用于 completion 防漂移。
- completion 只允许 claimed -> succeeded/failed/unknown 一次转换，并在同一事务中写入 strict `ExternalAction` Audit。Audit actor/workspace/execution/trace/resource/approval/outcome/ArtifactRef 必须与 claim 和 terminal 逐字段一致；不存在的 Artifact 或任何 Audit identity/hash drift 都回滚。
- restart recovery 只做最多 100 条的 cursor-bounded claimed 枚举，不自动重放外部动作；journal 总记录硬上限 65,536，满额 fail-closed、不驱逐历史幂等事实。

## 6. 幂等、安全和上下文

- journal 状态至少 claimed/succeeded/failed/unknown 并跨 restart；unknown 不自动重试写操作，router 内不 sleep/retry。
- UI/模型不能选择 URL、MCP server、Credential、revision、hash、sideEffect 或 Audit outcome。Provider/Tool/Knowledge output 是 untrusted tool result，不得拼接为 system/developer instruction。
- Audit/Debug/error 不含 token/header/raw payload/root path/provider internal text。Router 不依赖 UI、Office、Workflow、Experts 或 Task reducer。

## 7. 本切片边界与 Gate

允许独立 registration/decision kernel、Policy verification、journal/audit/executor ports、adapter contract 和 Hermetic Harness。禁止中心接线、旧 API、前端最终 schema、默认 Remote Shell、复制 MCP manager、伪造 Local materialization、用内存 journal 宣称生产幂等。

Kernel Harness 必须覆盖 Provider 矩阵、Local fail-closed、冲突、drift、revoke、approval mismatch、duplicate、timeout、unknown、oversize 和 no fallback。State journal/Audit、CrewON Provider contract/client/executor、Agent Platform server 和 Provider Artifact importer 已 Green；W2-05 v1 Gate 已满足。W2-08 仍必须等待 W2-04 至 W2-07 的其他生产前置，在同一切换中拦截 server-owned Provider dynamic tool 并删除 UI PIM executor；通用 client dynamic tool 继续走现有 request。
