# W2-04P Specification: Authenticated Principal

状态：Discovery、P1a、P1b、P1c bounded revocation/WebSocket selective disconnect/RemoteControl no-principal、Agent Platform durable auth-session family/epoch、principal-session/revoke source、CrewON bootstrap exchange、浏览器 WebSocket subprotocol、RS256 verifier/listener、P2b durable mapping/exact refresh、前端接线，以及默认关闭的 production composition 已完成；独立进程身份生命周期/restart，以及隔离 Provider v3 discovery/run/artifact、cancel 和 worker crash/restart Harness 已通过。生产 keyset 轮换、完整服务配置和真实云模型仍待实现。该 amendment 是 W2-04 Provider/Resource API、真实 Provider token issuer 与跨连接恢复的共同前置。

## 1. 问题与边界

当前 app-server 每个 transport connection 都生成新的 `sessionId`、connection-scoped `actorId` 和 WorkspaceRegistry。WebSocket auth 只返回 allow/deny，验签结果没有进入 `TransportEvent::ConnectionOpened`；RemoteControl client envelope 也没有可信 user/tenant/space claims。因此重连后 Credential owner 与 Workspace authority 必然变化。

Authenticated Principal 必须解决稳定授权身份，但不能改变以下边界：

- connection session、trace、client metadata 仍是短期连接事实；
- initialize/clientInfo/cwd/workspace params 不得构造 principal；
- capability token 只证明持有连接能力，不产生用户 principal；
- Stdio/InProcess 没有受信安装用户模型前继续 connection-scoped；
- RemoteControl 没有上游签名 claims/revoke feed 前继续 connection-scoped；
- raw token、签名、私钥和 Secret 不进入 RequestIdentity、DB、rollout、日志或模型上下文。

## 2. 双层身份模型

### Connection identity

- 每次连接生成新的 `sessionId`；
- `traceId` 每次请求独立；
- transport 和 client metadata 只用于审计/协商；
- 无 authenticated principal 时，actor 继续由 transport + session 派生。

### Authenticated principal

仅由 transport auth 成功后的 server-owned claims 构造，包含：

- exact issuer、audience、subject；
- exact tenantId、spaceId；
- token/session JTI、issuedAt、expiresAt，仅用于 freshness/audit，不参与稳定 actor hash；
- authentication source/version，不含 raw token。

稳定 `actorId` 使用 domain-separated SHA-256(`issuer`, `subject`) 派生 opaque ID。tenant/space 单独进入 RequestIdentity、PolicyActor 和 CredentialOwner；同 principal 重连时 actor/owner 相同，但 session/trace 必须不同。subject、issuer 或 tenant/space 变化不能复用旧 durable authority。

## 3. WebSocket claims Gate

现有 HS256 signed-bearer mode 保持兼容，但只有满足以下全部条件时才能输出 principal：

1. 服务端同时固定 expected issuer 与 audience；
2. token 同时携带 bounded `sub`、`tenantId`、`spaceId`、`jti`、`iat`、`exp`；
3. claims 无 partial principal；出现任一 principal 字段但不完整时拒绝整个连接；
4. `iat <= now + skew`、`exp > now`、`exp > iat`，并有硬生命周期上限；
5. 所有 ID 非空、trim 后等值、无控制字符且有 byte cap。

未携带 principal fields 的旧 signed token可以继续建立 connection-scoped 连接，但不能使用 durable Provider/Resource、持久 Credential 或跨连接 Workspace API。capability token 永远不输出 principal。

本阶段不把 HS256 WebSocket token复用为 Agent Platform RS256 service/delegation token；真实 Provider token issuer 只消费 `RequestIdentity` 中已经验证的 principal，并使用独立 keyset、typ/audience/scope/resource/Credential revision。

## 4. Revocation 与 freshness

- 过期 token 在 upgrade 前拒绝；现有连接到达 `expiresAt` 后必须由 connection supervisor 主动断开，而不是继续使用缓存 principal。
- Agent Platform 每次登录创建 opaque auth-session family + monotonic epoch；bootstrap 必须携带并在 principal session issue 同事务重验。logout 撤销当前 family，context switch 轮换当前 family，membership/binding removal 按 exact context 撤销，随后 JTI revoke source 驱动相关连接关闭。
- auth-session 的 server expiry 与 refresh-token lifetime 对齐并在合法 refresh/context switch 时滑动续期；过期 slot 有界回收。bootstrap assertion 与交换后的 principal-session `expiresAt` 都必须钳制到 family expiry，不能让连接 authority 活过登录族。
- P1c 首个实现采用 exact `(source, issuer, jti)` revocation key；事件必须携带原 token 的 `expiresAt`，仅保留到该时刻，禁止无界黑名单。
- revocation registry 必须先订阅事件再检查当前快照，覆盖 revoke-before-connect、subscribe/check 竞态与 broadcast lag；容量耗尽时全局 fail-closed 到已知最大 `expiresAt`，不能静默漏掉撤销。
- 同一 JTI 的所有活动连接都必须关闭；不同 issuer 或不同 JTI 的连接不得被误杀。重复 revoke 必须幂等。
- transport 只提供受信 revocation event 注入 contract 与连接监督。默认实例仍关闭 principal-session Gate；显式启用的 production composition 从 Agent Platform authoritative snapshot/read 注入 registry，任何 feed freshness 丢失都 fail-closed。
- subject、tenant、space 或 auth epoch 改变时，新连接不能接管旧 principal-owned state。
- RemoteControl pairing revoke 只撤销 remote client capability；在上游没有签名 user principal 前不等价于用户 logout。

RemoteControl P1c 审计确认其当前 envelope 只有 `clientId`、`streamId`、序号/cursor 和 JSON-RPC message，没有签名 user/tenant/space/JTI/expiry，也没有 principal revoke feed。因此 P1c 不向该协议添加本地伪 claims，不从 `clientId`、pairing account 或 initialize payload 推导 principal；它继续显式产生 `ConnectionScoped` authentication。

### RemoteControl future admission contract

RemoteControl 只有在上游同时提供以下事实后才允许增加新的 authenticated-principal source：

- 由受信 issuer 签名且由 app-server 本地验签的 exact issuer/audience/subject/tenant/space/JTI/issuedAt/expiresAt；
- 签名覆盖 `clientId`、`streamId` 与 principal session binding，阻止把另一个 controller/envelope 的 claims 搬运到当前流；
- audience、时间、生命周期和字符串 bounds 与 WebSocket principal 使用同一 domain validation；
- logout/subject change/JTI revoke feed 可驱动同一 revocation registry；pairing/device revoke 仍只撤销 controller capability；
- partial/null/unsigned claims 整个连接 fail-closed，不允许降级为“带部分身份的 connection-scoped”。

在该 upstream contract 真实存在前，不增加 wire 字段，不新增 source variant，也不开放 durable authority。

P1a 实现 immutable principal value、稳定 actor 派生和 RequestIdentity Harness；P1b 已接入 WebSocket claims 与 expiry disconnect；P1c 已接入 Agent Platform revoke source 与默认关闭的生产组合。W2-04 Provider API 在真实配置和 live Gate 完成前保持暂停。

## 4.1 P2b durable Agent Platform identity mapping

当前 `CredentialOwner` 已从 authenticated principal 的稳定 `actorId + tenantId + spaceId` 派生，不需要改写 Credential Store schema。`WorkspaceRegistry` 继续保持 session-scoped；P2b 不持久化绝对路径、旧 `workspaceKey` 或 `bindingId`。

P2b-1 已落地为未注册的 durable mapping kernel：

- 本地 owner 必须是 canonical `principal:<64 lowercase hex>`，并携带 exact non-empty tenant/space；connection-scoped actor 一律拒绝。
- 当前 provider 固定为 `agent-platform`，target 必须是 canonical positive tenant/space 与 `user:<positive integer>`；不提前抽象任意 Provider identity。
- binding target 创建后不可原地改写。revoke 是 terminal CAS；需要重新绑定时只能在旧 binding revoked 后创建新的 bindingId，避免静默 account switch。
- 同一本地 owner/provider 最多一个 active binding；同一个 provider tenant/space/subject 最多属于一个 active 本地 owner，防止 alias collision。
- 每个 binding 保存 server-owned authorityId、sourceBindingId、sourceRevision、revision、status、recordHash 与时间；不保存 access token、JWT、private key、email 或 display name。
- create/revoke 使用 `BEGIN IMMEDIATE`、expected revision 与幂等结果；reopen 后 active/revoked 事实必须 deep equal。
- P2b-1 API 只存在于 State 内部存储端口，不新增 app-server RPC。P2b-2a 负责证明 Credential owner exact match 后生成 `ProviderAuthorizationIdentity`；P2b-2b 已由 Agent Platform exact identity source + CrewON bounded refresh adapter 构造/撤销 mapping并证明 source freshness。

P2b-1 只证明持久化不变量，不证明调用者有权创建或撤销 binding。`authorityId/sourceBindingId/sourceRevision` 的可信来源、source freshness、Credential owner exact match 和 P2a identity 构造都属于 P2b-2；在这些事实未接入前，mapping API 不得注册为 RPC、UI action 或 CloudWorker production dependency。

P2b-2a 已增加 app-server 内部只读 resolver：

- 必须存在 server-verified `AuthenticatedPrincipal`，connection-scoped identity 直接拒绝；
- principal stable actor/tenant/space 必须与 `RequestIdentityRef` exact match，防止内部 identity projection drift；
- 调用方提供的 `CredentialOwner` 必须等于当前 authenticated identity 派生的 owner；
- 只按 local actor + tenant + space 查询 fixed `agent-platform` active mapping，跨 space、missing 或 revoked mapping 均不能生成 authority；
- 返回值只能由 validated mapping target 构造 `ProviderAuthorizationIdentity`，错误不携带 owner、subject、tenant、space 或底层数据库细节。

P2b-2a 不创建或撤销 mapping，也不验证 source freshness。P2b-2b authority 已归属 Agent Platform：新连接 resolve exact binding，已知 binding 只按 opaque sourceBindingId read current state，freshness 最多 60 秒；target immutable、status terminal，因此第一版不增加全局 snapshot/mutation feed。JTI/logout 的 gap-free revoke feed继续由 P1c 独立负责。真实 source API、durable auth-session epoch、bootstrap issuer、CrewON exchange 与前端接线已实现，但 production Gate 在真实配置和 live smoke 前保持关闭。

## 5. Harness

- 同 issuer/subject/tenant/space 的两次连接：actor/PolicyActor/CredentialOwner 相同，session/audit connection/trace 不同。
- subject、issuer、tenant 或 space 任一变化：不能产生等值授权身份。
- malformed/oversized/control-character/zero-or-inverted-time principal fail-closed。
- capability token、legacy signed token、Stdio/InProcess、未认证 RemoteControl 不产生 principal。
- partial claims、unconfigured issuer/audience、expired/not-yet-valid/overlong token lifetime 拒绝 upgrade。
- principal Debug、identity/read、errors、events、snapshot、rollout、model context 不包含 raw token/JTI 或未脱敏 subject。
- reconnect/revoke Harness 证明旧 Workspace/Credential key 不可被不同 principal 使用。
- auth replay Harness 证明 logout 后旧 access/refresh 与 logout 前 bootstrap 全部不能重新 mint principal session；context switch 只轮换当前登录 family，membership removal 不影响其他 context。
- expiry Harness 填满 32 个 active login slot，证明到期前 capacity fail-closed、到期后原子回收；短 auth lifetime 下 bootstrap 与最终 principal session 都在 family 到期点失效。
- P2b-1 Harness 证明 active owner/target 唯一、并发创建只有一个 winner、source binding 永不复用、terminal revoke CAS 幂等，以及 active/revoked 记录 close/reopen 后 deep equal。
- P2b-2a Harness 证明 unauthenticated、owner mix-up、cross-space、missing/revoked mapping 全部 fail-closed；只有 exact authenticated identity + exact CredentialOwner + active mapping 能构造 P2a identity。

## 6. Breaking-change 与停止条件

- P1a 只增加内部 identity type/constructor，不改变 v1/v2 RPC shape。
- 若 `identity/read` 需要暴露 principal，必须独立审查最小 projection；默认只复用 opaque actorId + tenantId/spaceId，不返回 issuer/subject/JTI。
- WebSocket signed bearer 的 principal claims 是 additive；旧 token 仍只能获得 connection-scoped 权限。
- `--ws-max-clock-skew-seconds` 现在有 300 秒硬上限；更大的旧配置会在启动前 fail-closed。这是有意的安全收紧，避免未来 `iat` 形成超长活动/撤销窗口。
- 不允许从 client request补 claims，不允许把 capability token升级为 principal，不允许本地 fallback 到 OS username。
- 没有 expiry/revoke supervision 时，不持久化 Provider connection/Workspace authority，不注册 CloudWorker production composition。
