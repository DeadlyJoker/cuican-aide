# W2-04PC Specification: Durable Provider Connection Identity

状态：设计、connection State kernel、Secret-free Provider Access Grant State kernel、principal-session exchange 内的 discovery-only grant provisioning、Grant + fresh mapping lifecycle resolver/Harness、grant-aware processor、deterministic secret-free projection adapter/resource DTO、默认关闭的 production descriptor factory/config kernel、startup/restart/config-removal/readiness composition，以及 experimental provider/connect/read RPC/schema/TestAppServer 已完成；client-selected Credential processor 已在 review 中撤回。Resource list/read 与 durable Resource Binding 待实现。

## 1. 必要性

W2-04 原草案把现有 `ProviderRef` 与 `CredentialRef` 作为 `provider/connect` 输入，但这两个类型包含 status、capabilities、scope、expiry 等服务端投影字段。客户端提交这些字段会产生 authority mix-up，且无法区分“选择一个引用”和“声明当前事实”。

同时，authenticated principal、Credential owner、Provider identity mapping 与 Workspace key 已可跨重连恢复，但 app-server 尚无 durable Provider connection identity。只增加内存 registry 会使 `provider/read`、Resource Binding 与后续 Task 在 app-server 重启后失去连接引用，重复此前 Workspace 的半持久错误。

## 2. 最小模型

本切片只保存不可变、非 Secret 的 Provider connection selection：

- `connection_id`：`provider-connection:<canonical UUID>`，随机 opaque；
- local authenticated owner：actor/tenant/space；
- `provider_id` 与 exact `protocol_version`；
- `credential_id` 与 positive exact `credential_revision`；
- `record_hash` 与 `created_at`。

State 不保存 endpoint、Credential Secret、token、Provider descriptor/capabilities、workspace、resource、policy decision、session/trace 或客户端 metadata。表对 exact owner/provider/protocol/credential selection 唯一；相同 selection 重放返回同一 connection，credential revision 或 protocol version 改变则形成新 connection。

## 3. Authority 与生命周期

- 只有 verified authenticated principal 的 processor 可以创建或读取 connection；State 记录本身不授予权限。
- 后续 processor 每次 read/connect 都必须重新派生 CredentialOwner，并 exact compare record owner。
- 后续 processor 每次使用都必须在 Provider I/O 前后重新 inspect server-owned Access Grant status/revision/scopes，并重新验证 current Provider identity mapping；persisted connection 不缓存 live authority。
- live descriptor 由 server-owned factory port 读取；production adapter 已复用 W2-03 endpoint policy/HTTP guard、strict descriptor 与 RS256 authorizer。factory 现在只在显式启用时于 transport accept 前注入私有 runtime，并先用 principal identity reader 刷新 durable mappings；配置关闭/移除、依赖缺失或刷新失败均不能留下可用 authority。
- Credential revoke/expire/rotation、Provider mapping revoke/stale、server config removal 或 descriptor mismatch 均 fail-closed；不得用 persisted projection 继续执行。
- connection immutable，不做原地 Credential rotation、protocol upgrade 或 owner transfer。

## 4. 后续 RPC 输入修正

`provider/connect` 不接受现有投影型 `ProviderRef`/`CredentialRef`。Agent Platform 首版只接受 `providerId`；server 从 authenticated principal + fresh identity mapping 解析唯一 active Provider Access Grant。endpoint、kind、protocol、owner、grant revision、status、scope、expiry、capabilities 与 adapter 均由服务端解析。connect 返回 server-owned `connectionId` 与 secret-free projection；projection 不包含 CredentialRef/grant reference。`provider/read` 按 connectionId 读取并重新验证 current authority。

## 5. 安全与边界

- ID、时间、revision 和记录数全部有硬上限；单条记录无正文和无界集合。
- Debug 隐藏 owner、Credential ID 与 record hash。
- 读取 persisted row 重新执行完整 validation/hash；tamper fail-closed。
- 不复用 provider identity binding 表，不把不同生命周期事实塞进同一 record。
- State/startup 阶段不新增 app-server RPC 或 UI，只建立私有 readiness-gated runtime；Stage D 在 processor 和 readiness Green 后才单独扩大 experimental wire surface。Access Grant 前置见 `W2-04-provider-access-grant`。

## 6. Harness

- Red Harness 先引用不存在的 record/outcome/State methods 并编译失败。
- create/exact replay、close/reopen、相同 selection 并发不同 connection ID 单 winner、owner/revision/protocol 隔离。
- invalid ID/revision/time/hash 拒绝；数据库 owner/hash tamper 后读取失败。
- 1024 条容量硬 Gate，不覆盖、删除或复用旧 connection。
- 显式 Provider v3 配置默认关闭；旧 Open API key、identity-source URL、模糊布尔值、部分配置和非 `/provider/v3/` 路径均不能构造 factory。
- 真实 RSA 私钥文件按 private-file 策略读取并清零源缓冲；live descriptor 请求具有 RS256 service/delegation authority，正文与 Debug 不泄露密钥、身份或旧 Secret。
