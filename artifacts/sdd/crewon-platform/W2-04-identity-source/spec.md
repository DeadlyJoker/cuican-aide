# W2-04IS Specification: Agent Platform Identity Source

状态：跨服务 Discovery、canonical binding contract、Agent Platform binding/session/revocation authority、durable auth-session family/epoch、Permission Service exact-membership/scope-context adapter、bootstrap issuer、exact source/session/revocation API、auth lifecycle revoke hook、CrewON bootstrap exchange、浏览器 WebSocket subprotocol、RS256 verifier、authoritative revoke listener 与受监督 production composition 已实现；独立进程的 logout/context-switch/member-removal/restart Harness，以及隔离 Provider v3 discovery/run/artifact、cancel 和 worker crash/restart Harness 已通过，三端仍由显式环境 Gate 控制且默认关闭。生产密钥供应/轮换、完整服务配置与真实云模型尚未完成，因此生产 Gate 继续关闭。

## 1. Authority 归属

P2b-2b 的唯一权威源归属 Agent Platform，而不是 `cuican-api` 或 CrewON 本地 app-server：

- Agent Platform 拥有 numeric User、`UserExternalIdentity` 和 Provider target `user:<id>`；
- Agent Platform Permission Service 拥有 Tenant、Space 与成员关系；
- `cuican-api` 只有自身 user/group、Cookie/access token 和 NewAPI 账号事实，不拥有 Agent Platform tenant/space membership；
- CrewON 只能消费受信 identity assertion，不能自行创建外部 user/tenant/space target。

`cuican-api` 可以作为外部登录 issuer 或账号入口，但不能单独签发 Agent Platform identity binding。

## 2. 基线缺口与当前剩余项

- Agent Platform legacy access token 仍不能直接升级为 CrewON WebSocket principal。identity Gate 启用后，只有同时携带 server-owned `crewon_auth_session_id` 与单调 `crewon_auth_epoch` 的新 access token 才能请求短期 bootstrap；缺失 claim 的旧 token 不能 bootstrap，旧 refresh 不能轮换为新 CrewON authority。
- WeCom exchange 仍只负责把外部身份解析为 numeric User；tenant/space 必须来自当前 access-token scope 并由 Permission Service exact membership 重新验证。
- `/auth/logout` 在 identity Gate 启用时只撤销当前 opaque auth-session family 及其 principal sessions；context switch 原子递增当前 family epoch、移动 exact context 并撤销该 family 的旧 principal sessions。membership/binding removal 才按 exact user/tenant/space 撤销所有 active auth families。旧 access/refresh、logout 前 bootstrap 与旧 epoch 都不能再次 mint session。
- auth-session 有服务端 `expiresAt`，默认与 Agent Platform refresh-token 生命周期对齐；同 scope refresh 或 context switch 只做滑动续期，过期 family 不能 bootstrap/session-issue，且新登录会有界回收其 active slot。bootstrap 与最终 principal-session 的 `exp` 均不得晚于当前 auth-session `expiresAt`。
- 第一版有意不发布全局 identity-binding mutation feed；已知 binding 使用 exact read + 60 秒 freshness，session/JTI 使用独立 gap-free revoke stream。
- durable binding、auth-session family/epoch、revision、terminal revoke、session registry、revoke stream 与前端交换链路已实现；独立进程 Harness 已覆盖真实 2048-bit RSA 密钥、logout/context switch/member removal、WebSocket selective disconnect 与 restart snapshot。隔离 Provider v3 Harness 已覆盖 Permission、Catalog/materialization、加密模型凭据、真实 HTTP 调用、durable Run/Event、MinIO Artifact、运行中 cancel 和 crash 后 unknownOutcome/at-most-once recovery。剩余风险集中在生产密钥轮换、完整服务配置与真实云模型。

## 3. 最小终态

### 3.1 Agent Platform authority binding

Agent Platform 为 exact `(principal actor, user, tenant, space)` 维护 durable binding：

- `authorityId = agent-platform-identity`；
- server-owned canonical UUID `sourceBindingId`；
- `sourceRevision` 从 1 开始；
- target immutable；
- status 只有 `active -> revoked`，revoked terminal；
- rejoin/rebind 创建新 sourceBindingId，不复活旧 binding；
- active 前必须重新验证 User active、Tenant active、Space active、User 同时是 Tenant/Space active member。

### 3.2 Exact resolve/read，而不是全局 snapshot/feed

第一版不增加全局 binding snapshot 或 mutation event stream：

- 新连接使用受信 principal assertion resolve exact binding；
- 已持久化 binding 只允许按 opaque `sourceBindingId` read current state；
- response freshness 最多 60 秒，超时或 source 不可用立即 fail-closed；
- app-server restart 后，任何 cached active mapping 在用于 Provider 签发前都必须 exact refresh；
- membership/user/external identity 失效时，read transaction 将 binding terminal revoke 后返回最新状态。

首次 resolve 不接受 bindingId/bindingRevision，因为 binding 尚未创建。流程固定为：

1. Agent Platform auth 先验证 durable auth-session family 的当前 epoch，再签发短期 bootstrap principal assertion，证明 exact user/tenant/space、opaque authSessionId/authEpoch，并携带可由 issuer+subject 复算的 stable actor；
2. CrewON app-server 使用独立 service credential + 原始 bootstrap assertion 调用 resolve；source API 同时验证两者且要求 `assertion.azp == service.sub`；
3. resolve 响应才产生 server-owned sourceBindingId/revision；
4. 后续 exact read 使用具备 `identityBinding:read` scope 的 service credential，并提交 sourceBindingId + expected local owner tuple；source API 必须与持久化 binding 精确比较，不提供 list/enumeration。

这是安全的最小协议，因为 binding target immutable 且状态单调 terminal，不需要回放中间 mutation。JTI/session logout 的 gap-free revoke feed 仍属于 P1c，不与 durable binding freshness 混为同一系统。

## 4. Canonical wire contract v1

canonical source 位于 Agent Platform：

`contracts/identity/v1/provider_identity_source.v1.json`

CrewON 只分发字节相同副本，并保存 canonical repository/path/SHA-256 provenance。

Contract 必须包含且只包含：

- `schemaVersion = 1.0.0`；
- fixed `authorityId`；
- source binding id/revision/status；
- local actor/tenant/space；
- exact Agent Platform provider subject/tenant/space；
- created/updated timestamp；
- domain-separated binding digest；
- response issuedAt/freshUntil。

禁止 email、display name、username、access token、refresh token、JTI、private key、Credential secret、absolute path 或客户端自报 authority。

## 5. Bootstrap 与 principal session contract

生产 resolve 前，Agent Platform 必须签发新的 asymmetric bootstrap principal assertion：

- `alg=RS256`，受信 `kid`；
- `typ=crewon-principal+jwt`；
- fixed `iss=agent-platform`、`aud=agent-platform-identity-source-api`；
- canonical `sub=user:<positive integer>`、`azp=crewon-app-server`；
- exact actorId/authSessionId/authEpoch/tenantId/spaceId、scope、JTI、iat、exp；authSessionId 必须是 canonical UUID，authEpoch 必须是 positive i64；
- actorId 必须等于 `stable_principal_actor_id(iss, sub)`，不能接受请求体覆盖；
- 最大生命周期 5 分钟，且可由 P1c revoke feed 主动断开；
- body/query 不能覆盖 claims。

service credential 与 Provider Run credential 分离：固定 identity-source audience、serviceAudience 和 scopes；resolve 需要 `identityBinding:resolve`，read 需要 `identityBinding:read`。service 与 principal keyset 分开配置，任一缺失、默认弱密钥、未知 kid、算法/typ/audience 混用或 scope 缺失都 fail-closed。

bootstrap assertion 不能直接作为 CrewON WebSocket principal session。resolve 成功后必须通过独立 session-issue 操作签发第二张 JWT：

- `alg=RS256`、受信 kid、`typ=crewon-principal-session+jwt`；
- fixed `iss=agent-platform`、`aud=crewon-app-server`；
- exact `sub=user:<id>`、actorId/tenantId/spaceId、sourceBindingId/sourceRevision；
- 独立 JTI、iat、exp，最大生命周期 1 小时；
- session-issue 必须按固定锁序 `binding -> auth-session -> principal sessions -> revoke stream` 重新 exact read active binding、重验 auth-session 当前 epoch，并要求 bootstrap claims 与 binding owner/target 完全一致；
- token 内容不能由 CrewON request body 覆盖，私钥只存在 Agent Platform server-owned issuer；
- logout、context switch、membership removal 与显式撤销必须进入 P1c gap-free JTI feed，CrewON listener 丢 cursor/freshness 时永久 fail-closed 直到重建 registry/restart。

Agent Platform kernel 与默认关闭的 composition 已冻结以下额外约束：

- 同一 bootstrap principal JTI 使用 domain-separated issue key 幂等重放，不保存 raw bootstrap/session token；
- `crewon_auth_sessions` 每个用户最多 32 个 active slot；每次登录一个 opaque family，refresh 必须保持 family/context/epoch 并滑动服务端 expiry，context switch 只轮换当前 family；过期 slot 在新登录事务中转为 terminal revoked 后复用容量，不允许永久耗尽 active slot；
- principal session 主记录继续只保存 exact principal claims digest、binding revision、JTI 与时间；独立 `crewon_principal_session_auth` 只保存 session JTI 到 authSessionId/authEpoch 的 domain-separated digest mapping，JWT 私钥与 raw token 均不落库；
- 每个 binding 同时最多 64 个未过期 active session，保证 membership/binding revoke 可以在单事务内有界完成；
- revoke 与 monotonic sequence event 在同一事务提交；stream 使用持久化随机 `streamId` 防止数据库重建后旧 cursor 被误接受；
- snapshot 固定 watermark 分页，incremental read 固定 cursor；过期事件只允许按连续前缀有界压缩，落后于 compaction cursor 必须 fail-closed 并重建 snapshot。

两张 token 的 audience、typ、lifetime 和用途不可互换：bootstrap 证明“允许创建/解析 binding”，principal session 证明“此连接当前绑定到哪一个 immutable binding revision”。

旧 Agent Platform access token、WeCom ticket、`X-Internal-Secret` 和 `cuican-api` Cookie 都不能替代该 assertion。

## 6. Freshness 与故障语义

- identity binding response `freshUntil - issuedAt <= 60s`；
- response issuedAt 允许最多 300 秒时钟偏差；
- local adapter 只在 `now < freshUntil` 时使用 active binding；
- timeout、5xx、invalid JSON、digest drift、revision regression、scope mismatch 一律不可继续签发；
- background Task 在 freshness 过期后进入 suspended/reconcile，不降级为 connection-scoped 或旧 mapping；
- source 恢复后 exact read，只有同 binding 的更高/相等 revision可恢复；revoked 永不恢复 active。

## 7. Stable actor 字节契约

stable actor 固定为 domain-separated SHA-256：

`SHA256("crewon.authenticated-principal.v1\\0" + u64be(len(issuer)) + issuer + u64be(len(subject)) + subject)`

长度必须固定使用 unsigned 64-bit big-endian；禁止使用平台相关 `usize`。Rust/Python 已用 `agent-platform + user:42` known vector 固定为：

`principal:6f7900eaed3218b4c15249cad129ed96bf1bde4d0524fa4b6fad1ba325e8ef3f`

## 8. 非目标

- 不新建独立 Identity 微服务。
- 不让 `cuican-api` 复制 Agent Platform membership。
- 不做全局 binding enumeration、snapshot 或 Kafka feed。
- 不把旧 JWT 包装成新 assertion。
- production composition 已存在不等于生产 Gate 可以打开；真实配置、前端接入与 live smoke 仍是独立验收条件。
