# W2-04PAG Specification: Provider Access Grant

状态：Discovery、契约纠偏、Secret-free durable State kernel、Agent Platform principal-session exchange 内的 server-owned exact-scope grant provisioning、复合 Grant + fresh identity lifecycle resolver/Harness、grant-aware connect/read processor、deterministic secret-free projection adapter、transport accept 前的 startup/restart/config-removal/readiness composition，以及 experimental provider/connect/read RPC/schema/TestAppServer 已完成；既有 client-selected Credential processor 已撤回。W2-05 amendment 将 scope 固定为 `provider.discovery`、`providerKnowledge:search`、`providerTool:call`，客户端仍不能选择 scope，实际外部执行仍需 exact 短期 delegation。Resource API 与 product Gate 仍关闭。

## 1. 已确认事实

- Agent Platform 的 Provider Run delegation 虽使用 `credentialId/revision/ownerSubject`，但它把这些字段作为 CrewON 签发的委托授权绑定参与 digest、幂等和 drift 检查，不用它们读取云模型 Secret。
- Agent Platform 会根据已授权用户、不可变 AgentVersion 和 server-owned model binding，在服务端从 `UserModelApiKey` 或 `NewApiAccountBinding` 解析真实模型密钥；CrewON 不应复制、持久化或转发该密钥。
- 当前 `CredentialStore` 是 Secret-bearing vault port，创建记录必须提交 `CredentialSecret`。它适合本地 API key、OAuth token 等真实 Secret，不适合伪造一个未使用 Secret 来代表 Provider 授权。
- 当前没有 production Credential create/list/read/provisioning API。要求客户端先提交 `credentialId/revision` 会使首次连接无法完成，并把 server-owned authority selection 推给客户端。

## 2. 必须分离的三个概念

1. `ProviderIdentityMapping`：稳定 authenticated principal 到 Agent Platform identity/source binding 的映射；由 authoritative identity source resolve/read，带 freshness 和 terminal revoke。
2. `ProviderAccessGrant`：CrewON 服务端签发的、Secret-free、可撤销且带 revision 的 Provider 委托授权引用；用于 discovery/run authorization、Provider connection 和 Task journal 的 exact binding。
3. `ProviderSecret`：只有真正需要访问外部系统的 Secret 才进入 `CredentialStore`/Vault。Agent Platform 的模型 API key 继续只存在于 Agent Platform 服务端。

不得用随机占位 Secret 把 Access Grant 塞进 `CredentialStore`，也不得把 Agent Platform 的内部 model route id 当成 CrewON CredentialRef。

## 3. Agent Platform 最小授权流

1. 浏览器用当前 Agent Platform access token 获取一次性 bootstrap proof。
2. app-server exchange 验证 proof，resolve exact Provider identity，持久化同 owner/source/revision 的 mapping，再向 Agent Platform issue principal session；任一步失败都不向客户端返回 session。
3. Provider Access Grant provisioner 只消费已经验证的 principal、fresh mapping 和 server-owned policy，创建或复用 exact active grant；不接收客户端 owner、scope、revision 或 Secret。
4. Agent Platform 的 `provider/connect` 最终只提交 `providerId`。processor 从当前 authenticated principal 解析唯一 active grant，再读取 live descriptor；零个、多个、stale、revoked 或 revision drift 全部 fail-closed。
5. Provider Run delegation 使用该 grant 的 id/revision/owner；Agent Platform 仍独立重验 resource permission，并自行解析内部模型密钥。

其他未来 Provider 如果需要 OAuth/code 等一次性 Auth Proof，应先在各自的 server-side provisioning boundary 中把 proof 兑换为 Access Grant；proof 有严格大小/寿命/单次消费限制且绝不进入 connection record。它们不能扩展 Agent Platform 首版输入为通用可选 Secret 字段。

## 4. 最小 Access Grant 模型

- opaque `grant_id` 与 positive monotonic `revision`；
- exact authenticated owner：actor/tenant/space；
- `provider_id`、bounded granted scopes、status、expiry；
- source binding id/revision 或其 domain-separated digest，用于 mapping drift/revoke 联动；
- created/rotated/revoked timestamps 与 canonical record hash。

记录不保存 raw proof、principal/session token、模型 API key、endpoint、workspace root、resource manifest、prompt 或 Provider response。Debug、错误、schema、日志和 projection 不暴露 owner/source binding。

State kernel 已以 migration `0044_provider_access_grants.sql` 落地该模型。每个 authenticated owner/provider 同时最多一个 active grant；同一 source binding/revision 也不能被不同 owner 并发占用。过期记录不再通过 active lookup，但 provisioning 可按 owner/provider 读取 current record，并在同一 `BEGIN IMMEDIATE` 事务中校验容量/冲突、CAS terminal revoke current grant、插入 replacement。任何校验或插入失败都保留原 active grant，不自动扩大 scope，也不接受同 source 的 revision 回退。

## 5. 并发与生命周期

- 同 owner/provider/source revision 的并发 provision 只能产生一个 active grant；exact replay 返回同一 grant。
- source binding、principal scope 或 policy scope 变化创建新 revision 或新 grant，不能原地扩大权限。
- logout/JTI revoke 关闭连接 authority；mapping terminal revoke、grant revoke/expiry 或 source revision drift 会阻止新的 connect/run。
- connection/read/run 在外部 I/O 前后重验 current grant metadata 与 fresh identity mapping；State 中的 connection/grant record 本身不授予权限。

## 6. 停止条件

- Agent Platform provisioner、复合 authority lifecycle Harness、未注册 processor core、projection adapter 与 startup readiness Gate 已完成；在方法级 RPC/TestAppServer Harness 通过前不注册 RPC，也不把内部 runtime 误标成公开产品能力。
- 不复用 `LocalCredentialStore` 的 Secret 字段保存占位值。
- 不让 UI 选择或提交 owner、scope、status、revision、endpoint 或已存在的 grant id 来创建首次连接。
- 不为尚未出现的第二种 Provider 预建通用 OAuth 框架。
