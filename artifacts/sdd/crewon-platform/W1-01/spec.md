# W1-01 Server-derived Request Identity 规格

状态：已完成  
上位任务：<code>artifacts/crewon-platform-wave-sdd-execution-guide.md</code> W1-01

## 当前事实

- app-server transport 为每次连接产生 <code>ConnectionId</code> 和可信 <code>ConnectionOrigin</code>，但 <code>ConnectionState::new</code> 当前丢弃 origin。
- initialize 的 clientInfo 与 capabilities 完全由客户端声明，只能作为显示/协商信息，不能成为 actor、tenant、space 或授权依据。
- WebSocket capability token 只证明持有共享能力；signed bearer token 当前仅验证 exp/nbf/iss/aud，claims 没有 sub/tenant/space，验证结果也没有传入 app-server。
- Stdio/InProcess 是当前进程建立的本地通道；WebSocket/RemoteControl 在没有可信 subject claims 时只能识别为连接级远端主体。

## 本切片目标

- 在 app-server <code>platform_control</code> 下建立公开、UI 无关的 <code>RequestIdentity</code> 类型。
- 每次 transport connection 创建不可复用的 server session id，并据此派生 connection-scoped actor id 和 audit subject。
- 每次请求绑定服务端 request trace；同一上游 trace 可以跨请求关联，无有效 trace 时生成服务端关联 id。同一连接的 actor/session 稳定，重连后变化。
- 新增 experimental v2 <code>identity/read</code>，只返回服务端当前有效身份，用真实 TestAppServer 验证，不添加测试专用后门。
- W1-10 之前不把 identity 广泛穿透所有业务 Processor；本切片只完成连接/session 基座和只读验证面。

## 可信来源矩阵

| 字段 | 当前来源 | 权威性 |
|---|---|---|
| sessionId | server UUID at ConnectionOpened | 可信，仅当前连接生命周期 |
| transport | TransportEvent ConnectionOrigin | 可信 |
| actorId | transport category + server session id | 可信的连接级 actor，不等价于用户 |
| auditSubject | server-defined transport category + server session id | 可信、连接唯一的审计主体 |
| traceId | server request span trace id；可继承上游 trace；无有效 trace 时 server UUID | 仅用于可观测性关联，可能由上游传播，绝不参与授权或唯一性判断 |
| client name/version/capabilities | initialize clientInfo/capabilities | 客户端声明，只读元数据 |
| tenantId/spaceId | 当前无可信 claims | 必须为 null |
| user/member/credential owner | 当前无可信来源 | 不属于本切片，不能猜测 |

## 安全不变量

1. <code>identity/read</code> 无请求 Params；actorId、tenantId、spaceId、memberId 等注入必须被 schema 拒绝。
2. tenant/space 在可信 claims 接线前始终为 null；不得从 clientInfo、cwd、Office config 或请求字段补值。
3. WebSocket capability token 不等价于用户身份；RemoteControl token 也不自动成为用户 subject。
4. connection actor/session 不持久化到 rollout、Office JSON、UI localStorage 或数据库。
5. 重连创建新 session/actor；旧连接 identity 不能复用。
6. declared client capabilities 与 authority 明确分层，业务授权不能读取前者作 allow 决策。

## API

- 方法：<code>identity/read</code>，experimental v2，无 Params。
- 响应：canonical <code>RequestIdentityRef</code> + transport + auditSubject + declared client metadata/capabilities。
- 不返回 Secret、token、绝对路径或 OS 用户信息。

## 非目标

- 不新增登录系统，不修改 account auth。
- 不在本切片扩展 JWT claims 或改变 WebSocket token 格式。
- 不接入 Workspace、Credential、Task、Office 或 Policy 规则。
- 不把 RequestIdentity 写入所有 Processor；统一 composition 在 W1-10 完成。

## 兼容与影响面

- 新增 experimental v2 方法，不修改现有方法和 initialize v1 形状。
- CLI、配置、rollout/session 恢复、Core model context 均不变化。
- app-server transport public enum 不变化，只开始消费已存在的 ConnectionOrigin。

## 验收

- Harness Red 证明实现前 identity/read 不存在。
- TestAppServer 证明同一连接身份稳定、不同连接/重连身份隔离、伪造 Params 被拒绝。
- unit test 覆盖四种 transport 的分类，以及 tenant/space fail-closed。
- schema、app-server protocol 和 app-server targeted tests 通过。
