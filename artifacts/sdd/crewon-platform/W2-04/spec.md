# W2-04 Specification: app-server Provider / Resource v2 API

状态：W2-04 implementation Gate Green。Authenticated Principal、真实 issuer/logout/revoke source、durable CredentialOwner/Provider identity/workspace/connection/Access Grant/Resource Binding、principal-exchange provisioning、composite lifecycle resolver、grant-aware processor、live Catalog、deterministic secret-free projection、默认关闭的 production Provider factory/startup readiness，以及 experimental `provider/connect/read/resource list/read/bind/unbind` v2 RPC/schema/TestAppServer 和 current-connection-only binding notification 已完成。client-selected Credential 首连不可达的旧 selection DTO 已撤回；完整 workspace release evidence 仍等待用户授权。

## 1. 已确认事实

- 未认证连接的 `RequestIdentity.actorId/sessionId` 仍由每次 transport connection 生成；完整 WebSocket principal 已稳定派生 actor/tenant/space，CredentialOwner 与 exact Agent Platform Provider identity 可跨受信重连恢复。
- authenticated `workspaceKey` 已由 State path-free root mapping 跨 app-server process 恢复；Workspace scope `bindingId` 仍为 session-owned，Resource Binding 不得把它误当 durable identity。
- `credential_owner(identity)` 对 verified principal 跨连接稳定；connection-scoped transport 仍不能获得 durable Credential/Provider authority。
- 旧 `AgentPlatformRequestProcessor` 仍接受客户端 token/cwd 等旧参数；它不能被包装成 server-owned Provider connection。
- W2-03 adapter 已提供安全的 discovery/Catalog/Run port，但不拥有用户身份、Credential Store、Workspace 或 connection lifecycle。
- Agent Platform 的真实模型密钥由其服务端按 user + immutable Agent model binding 解析；CrewON delegation 中的 Credential 只是授权绑定，不能用占位 Secret 或客户端 selection 代替 provisioning。

## 2. 发现的矛盾

原 W2-04 同时要求：

1. 多 session 不错误共享 connection state；
2. app-server/WebSocket 重连后可恢复 Provider connection；
3. Credential owner 和 Workspace authority 必须服务端派生；
4. 客户端不能重新提交 Secret、owner 或 workspace root。

在当前 connection-scoped identity 下，上述四项不能同时成立。按旧 actor 恢复会越权；按新 actor 校验会使旧 Credential/Workspace 全部不可访问；放宽 owner 或复用旧 session 又破坏 W1-01/W1-03 的安全不变量。

## 3. 必要前置：Authenticated Principal Gate

W2-04 实施前必须由独立 amendment 提供可验证、可恢复的服务端 principal：

- WebSocket/RemoteControl：只接受认证层验证后的 stable subject/tenant/space，不读取 initialize/clientInfo 自声明字段；
- Stdio/InProcess：若要持久化，必须定义受信本机安装/用户 principal 及其迁移、撤销和多用户边界；否则继续保持 session-scoped；
- `RequestIdentity` 区分 connection session 与 authenticated principal，授权使用 principal，trace/audit 仍保留 connection session；
- Credential owner、durable Workspace identity 和 Provider connection owner 使用同一 principal derivation；
- token refresh、logout/revoke、subject change 和 reconnect 都有 fail-closed Harness。

该 Gate 不得在 Provider processor 内临时实现，也不得把共享 WebSocket capability token当作用户身份。

当前 amendment 进度：P1a/P1b/P1c、真实 identity source/logout revoke、durable auth-session epoch、CredentialOwner、Provider identity mapping/freshness、RS256 issuer kernel、durable workspace、Provider connection/Access Grant/Resource Binding State、principal-exchange server-owned Provider grant provisioning、composite lifecycle resolver、grant-aware processor、live Catalog、projection/resource DTO、production descriptor factory/config kernel、startup readiness，以及 experimental Provider/Resource RPC 均完成。W2-05 amendment 将 Grant scope 从 discovery-only 修订为唯一允许的严格排序集合 `provider.discovery`、`providerKnowledge:search`、`providerTool:call`；客户端仍不能提交 scope，实际外部执行仍使用单资源/单操作短期 delegation。principal exchange 在返回 session 前保存 authoritative exact mapping，并确保 exact Grant 已创建或复用；任一步失败均不向客户端返回 session authority。启动时先刷新 durable mappings，依赖或 source/state/snapshot 失败均在 transport accept 前 fail-closed。Resource Binding 又拆成 B1 State、B2a1 Workspace proof、B2a2 Federation/State adapter 和 B2b wire/notification 评审切片。

## 4. Gate 通过后的最小 API

仅在 durable Provider connection prerequisite 完成后新增 app-server v2：

- `provider/connect`：Agent Platform 首版客户端只提交 providerId；app-server 从 verified principal、fresh mapping 与 server-owned Provider Access Grant 解析 exact credential/grant revision。需要 OAuth/code 的其他 Provider 必须先通过独立 server-side proof provisioning；
- `provider/read`：按 server-owned connectionId 返回 path-free/secret-free live projection 与 capability；
- `resource/list`：`cursor/limit/provider/kind`，默认 cursor pagination；
- `resource/read`：读取 exact revision manifest；
- `resource/bind`：提交 workspace binding ref、exact resource ref、binding mode；服务端解析 capability/execution location；
- `resource/unbind`：按 server-owned binding ID 幂等解除；
- projection notification：只含 connection/resource/binding 状态与 cursor，不含 endpoint Secret、Credential owner 或 workspace root。

业务逻辑放在独立 Processor/registry；`common.rs`、`message_processor.rs` 在 W2-04 只允许方法注册、请求分发、response 映射和 initiating-connection notification。Task、Tool、UI 与跨领域 Provider Control composition 仍只能由 W2-08 接线。

## 5. Harness

- 真实 TestAppServer 覆盖 authenticated reconnect、subject change、logout/revoke、多 session 隔离和 cursor recovery。
- fake Provider + fake Provider Access Grant Store 覆盖 provision/connect/list/read/bind/unbind、capability drift、grant revision/revoke。
- 伪造 actor/tenant/space/workspace root/Credential owner/endpoint 全部被 schema 或服务端 authority 拒绝。
- Schema/TS fixture 证明所有 Client Params 不含 Secret 或最终 authority。

## 6. 停止条件

- 没有 stable verified principal 时，不创建“看似可恢复”的 Provider connection API。
- 不用 localStorage/cookie 中的客户端 owner 或旧 sessionId 修补恢复。
- 不把 experimental W2-04 API 实现扩大解释为 Wave 2 production cutover；W2-05/W2-06 必须各自完成 SDD/Harness，W2-08 仍等待 W2-05 至 W2-07。
