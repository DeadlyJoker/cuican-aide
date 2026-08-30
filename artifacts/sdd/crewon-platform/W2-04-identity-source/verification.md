# W2-04IS Verification

状态：Discovery、canonical contract、Agent Platform binding/principal-session/revocation authority、bounded durable auth-session family/epoch、Permission Service exact-membership/scope-context adapter、独立双签名 auth boundary、exact source/session/revocation API、bootstrap issuer、auth lifecycle revoke hook、CrewON refresh/exchange、浏览器 WebSocket subprotocol、RS256 verifier、authoritative revoke listener、前端接线与默认关闭的 production composition Green；独立进程身份生命周期/restart，以及隔离 Provider v3 discovery/run/artifact、cancel 和 worker crash/restart Harness 已完成。生产 keyset 轮换、完整服务配置、真实云模型和 production Gate 未完成。

## Discovery evidence

- `cuican-api` User 只有本地 integer id、group、Cookie/access token；logout 只清 session，不拥有 Agent Platform Tenant/Space membership。
- Agent Platform `UserExternalIdentity` 已以 `(provider, issuer, subject)` 唯一映射 numeric User；WeCom flow 使用该表防止 identity alias collision。
- Agent Platform Permission Service 拥有 Tenant、Space、TenantMember、SpaceMember 和 active membership 查询。
- Agent Platform legacy access token 缺少新 auth-session claims，不能作为 CrewON principal assertion；WeCom exchange 可以先获得无 context 的 durable login family，之后只能由 refresh/context-switch 在服务端轮换 epoch 并绑定 Permission Service exact context。
- durable binding target immutable、status terminal，因此 exact binding read + bounded freshness 足以证明当前状态；全局 snapshot/mutation feed 会扩大隐私面和实现复杂度，已从第一版删除。

## Contract evidence

- Agent Platform canonical：`contracts/identity/v1/provider_identity_source.v1.json`。
- CrewON distribution：`codex-rs/app-server-protocol/schema/canonical/provider_identity_source.v1.json`。
- 两侧当前字节完全一致，SHA-256 为 `09899f813c9c954a5dbf4b05da51d32fecd464c14e4f0d205bab1e2b7860ac92`。
- Python strict model 拒绝 missing/extra、connection actor、scope mix-up、active revision drift、未知 status、digest drift、freshness 超限、非 UUID 与 u64 overflow。
- Rust strict parser 限制 response 16 KiB、ID/scope bounds、canonical UUID/u64、active/revoked invariants、domain digest、300 秒 clock skew 与 60 秒 freshness；Debug 不暴露 actor/subject。
- stable actor 长度前缀已从平台相关 `usize` 修正为 fixed u64；当前 64 位值不变，known vector 由 Rust/Python 同时固定。

## Authority kernel evidence

- Agent Platform 新增 `crewon_identity_bindings` durable record；active owner 与 active target 分别使用数据库 partial unique index，防止 alias/mix-up。
- active binding 固定 revision 1 且 target immutable；membership loss 或 explicit revoke 只允许进入 terminal revoked revision，rejoin 会创建新的 binding id。
- resolve/read/revoke application 只依赖 `MembershipAuthorizer` port；HTTP、bootstrap/session issuer 与 lifecycle hook 仅在显式 identity Gate 启用时注册或执行，默认路径不产生新行为。
- resolve 并发 race 由数据库唯一约束裁决；重复 exact tuple 幂等返回，owner/target 冲突 fail-closed。
- read 对 active binding 重验 membership；authority 报错映射为 unavailable 且不会误撤销，明确返回 false 才执行 CAS terminal revoke。
- identity/scope 字段从 Pydantic `repr` 隐藏；应用错误只返回稳定非敏感 code。
- Permission Service 新增仅限 internal-secret 的 exact-membership 检查；必须同时满足 active Tenant、归属该 Tenant 的 active Space、active TenantMember 与 exact SpaceMember，响应只返回 `active: bool`。
- Agent Platform adapter 要求响应恰好只有 boolean `active`；缺失、类型漂移或额外角色/成员信息一律视为 unavailable，并由 identity application fail-closed。
- context switch 不再把 Agent Platform 用户 JWT 转发给 Permission Service 的公开 Tenant/Space API，也不再缺失时伪造 `member/viewer`。新增 internal-secret-only `scope-context` 精确查询，一次返回 active scope 的 server-owned tenantId、bounded tenantRole 与 bounded spaceRole；非成员或 expected tenant mismatch 只返回 inactive/null，服务失败或畸形响应映射 503，inactive 映射 403。

## Source auth/API evidence

- identity-source service credential 与 Provider Run 使用不同 audience、serviceAudience、scope 和环境配置；bootstrap principal assertion 使用独立 keyset。
- resolve 同时验证 RS256 service token 与 Agent Platform principal assertion，要求 `assertion.azp == service.sub`，并复算 `stable_principal_actor_id(assertion.iss, assertion.sub)`；assertion 中出现尚未创建的 bindingId 会因 strict extra-forbid 被拒绝。
- shared RS256 decoder 统一限制 alg/typ/kid、危险 JOSE header、16 KiB token、iat/exp、30 秒 clock skew 和最大生命周期；Provider Run 既有 verifier 已回归 Green。
- isolated source API 的 resolve 不接受 body/query authority；read 只接受 sourceBindingId + expected local owner，并在 membership lookup 前 exact match，错误响应不包含 binding/actor/scope。
- signed API 共用 bounded HTTP parser：拒绝 duplicate header、duplicate JSON key、非 JSON/encoding、Content-Length 欺骗与流式超限。
- Agent Platform main app 已通过 `IDENTITY_SOURCE_ENABLED` 挂载单一 `/identity/v1` boundary；flag 默认 false、只接受精确布尔值，启用时缺少 service/principal keyset、subject allowlist、Permission 配置或 signing key 会在启动前 fail-fast。
- 用户 bootstrap endpoint 只从当前 access token 取得 exact user/authSessionId/authEpoch/tenant/space，先重验 durable auth-session 当前状态和 membership，再签发最长 5 分钟且不晚于 family expiry 的 RS256 assertion；bootstrap 私钥必须与 identity boundary 的 trusted principal public key 匹配。

## CrewON refresh evidence

- Agent Platform identity-source client 复用 Provider endpoint policy：固定 `/identity/v1/`、DNS pinning、loopback/dev 与 HTTPS/prod 规则、无 redirect、bounded response；resolve/read 使用不同敏感 header 形态。
- source read 同时校验请求的 sourceBindingId 与 expected local owner；即使服务返回另一个合法 binding snapshot 也会拒绝，不能把一次 refresh 变成错误 mapping 创建。
- local mapping 新增 `sourceFreshUntil`，active authorization 查询必须满足 `sourceFreshUntil > now`；旧 v1 record 经 0041 migration 得到 freshness=0，保留可迁移 hash 但永不被授权。
- freshness refresh 使用 local revision CAS；相同请求幂等，freshness regression、source/owner/target drift 和 revoked resurrection 全部冲突。
- restart supervisor 以 cursor + page size + max bindings 双重硬上限读取 active mapping；任一 source/state/snapshot 失败都不返回 `ReadyProviderIdentityMappings` capability。
- Provider identity authorization 现在同时要求 Ready capability、authenticated principal、exact CredentialOwner 和 fresh active mapping。

## Principal session / P1c source kernel evidence

- Agent Platform 新增 `crewon_auth_sessions`：每次登录一个 opaque UUID family + monotonic epoch + optional exact context，每个用户最多 32 个 active partial-unique slot；无 context WeCom family 可安全过渡，旧 refresh 无 claims 在 Gate 启用后直接 401。
- login/register/WeCom/customer-entry 在 Gate 启用时签发同一 family 的 access+refresh；refresh 不再把 context-bearing refresh 降级为仅含 `sub`，且必须重验 family/context/epoch。logout 只撤销当前 family，context switch 只轮换当前 family，membership/binding removal 才按 exact context 撤销全部 family。
- family `expiresAt` 与配置的 refresh-token lifetime 对齐；同 context refresh/context switch 滑动续期，过期 family 立即 fail-closed。Harness 先填满 32 个 active slot，证明未过期时返回 capacity、到期时在新登录事务内转为 terminal expired 并释放 slot。
- bootstrap assertion 与最终 principal session 的 `exp` 都钳制到当前 family `expiresAt`；即使 refresh lifetime 被配置得短于 5 分钟/1 小时，交换出来的 authority 也不能活过登录族。
- Agent Platform principal session issuer 只消费已验签 bootstrap authority 与 opaque sourceBindingId，并按 `binding -> auth-session -> principal sessions -> revoke stream` 固定锁序重新 exact read active binding和当前 auth epoch；user/actor/authSessionId/authEpoch/tenant/space/target 任一 drift 都不能签发。
- session JWT 固定 `RS256`、trusted `kid`、`typ=crewon-principal-session+jwt`、`iss=agent-platform`、`aud=crewon-app-server` 与 1 小时上限；签名 key 构造时校验 RSA >= 2048 bit，私钥与 raw token 的 repr 均脱敏。
- 同 bootstrap JTI 重试与进程重启返回同 session JTI/claims；数据库只保存 principal claims digest，以及独立 `crewon_principal_session_auth` 中 session JTI 到 authSessionId/authEpoch 的 digest mapping，不保存 raw bootstrap、access、refresh 或 principal session token。
- exact logout/context switch 与 binding-level membership/binding revoke 都在 session 状态变更的同一事务写入 monotonic revocation event；binding active-session cap 为 64，批量撤销保持硬上限。
- durable random streamId 防止数据库重建后旧 cursor 混入；snapshot 使用固定 watermark，read 使用 exact stream cursor，事件只按已过期连续前缀压缩，旧 cursor 进入 compaction gap 后 fail-closed。
- session issue 会在同一事务重新锁定 active binding 和 auth-session epoch，避免 membership/binding/logout/context-switch 与 session issue 的 stale-active race；锁顺序固定为 binding → auth-session → principal sessions → revocation stream。
- exact resolve 并发 Harness 连续 10 次通过：相同 actor/target 的可见性竞态按 exact tuple 幂等返回；同 owner 不同 target 或同 target 不同 actor 仍保持 conflict fail-closed。
- HTTP boundary 增加独立 `principalSession:issue` 与 `principalRevocation:read` service scopes；issue 仍要求原 bootstrap assertion，revocation snapshot/read 明确拒绝 principal header。
- issue body 只有 opaque sourceBindingId；actor/user/tenant/space/JTI/expiry 都不能由 body/query 覆盖。snapshot/read 使用 strict cursor/watermark/limit DTO，response 每页最多 100 条。
- duplicate Authorization/principal header、duplicate JSON key、非 JSON、query authority 与 16 KiB 超限全部 fail-closed；这些 HTTP Harness 已纳入 identity 聚合回归。
- Agent Platform production composition 初始化 durable revocation stream 后才允许服务；startup 任一阶段失败会按启动顺序清理 identity/provider composition，避免半启动状态。
- CrewON Agent Platform client 增加 session issue、revocation watermark snapshot 与 cursor read；继续复用 pinned endpoint、no redirect、bounded response 与 strict JSON/error contract。
- client 对 sourceBindingId/streamId/JTI 做 canonical UUID 复验，固定 issuer=`agent-platform`，拒绝过期/时间倒置事件、非单调 sequence、cursor regression、wrong stream 与每页超过 100 条；token、JTI、streamId 和 bindingId 的 Debug 均脱敏。
- client 额外固定 snapshot watermark、sequence 下界、i64 sequence 上界、next cursor 与最后事件一致性；公开 cursor/event 构造器自身校验并避免无效 page 触发 panic。
- CrewON RS256 verifier 固定 `alg/typ/iss/aud/kid`，拒绝 `jku/jwk/x5u/x5c`、未知 claim、非 canonical subject/scope/binding/JTI 与 1 小时以上 lifetime；transport principal 的 source/binding 合法组合在 transport 与 app-server 两层穷尽校验。
- authoritative listener 在 WebSocket listener 启动前执行 bounded watermark snapshot + immediate catch-up，之后以 1 秒间隔轮询；每次 source call 5 秒超时，stream/watermark/cursor drift、source timeout、容量超限或本地时钟异常都会永久 `freshness_unknown` 并唤醒活动连接 fail-closed。正常 cancellation 不伪造 freshness loss。
- listener 只发布 exact `(WebSocketPrincipalSessionRs256, agent-platform, JTI)` 撤销，不保存 raw token；registry hard cap 4096，过期项有界清理。
- `TransportAuthentication` 对大 principal 使用 `Box`，避免把约 224B principal 内联复制到所有连接事件；app-server 连接入口已显式接受 RS256 verified source，不再在 transport 验签成功后被旧 signed-bearer 白名单误拒绝。
- CrewON `CREWON_PRINCIPAL_SESSION_ENABLED` 默认 false；启用时只允许 WebSocket transport、拒绝与 legacy WS auth 并存，并要求显式 HTTPS production 或 development-loopback endpoint mode、独立 service signing key、bootstrap/session trusted keysets。
- production startup 在绑定 WebSocket 前完成 authoritative snapshot + immediate catch-up，再启动 listener；acceptor 启动失败会取消并等待 listener，listener freshness 丢失会使 registry 永久 fail-closed。
- `/principal-session/exchange` 使用 16 KiB body/token cap 和 32 并发上限，只返回最终 session token/expiry；bootstrap verifier、owner、resolve 与 issue 任一失败都不回显 token或身份细节。
- exchange 现在把 authoritative resolve 返回的 active exact binding snapshot 写入本地 State 后才允许返回 principal session；正常路径可立即支持后续 Provider authority lookup，owner drift 或 State conflict 不落权威且不返回 session。targeted Harness 4/4 通过。
- 本轮完整 app-server 回归 1059/1059 通过，1 skipped；mapping 修复未增加或修改 v1/v2 RPC、CLI、配置字段或 rollout resume surface。

## Frontend / browser transport evidence

- `VITE_CREWON_PRINCIPAL_SESSION_ENABLED` 默认 false且只接受精确 `true/false`；关闭时 `AppServerClient` 构造和既有 WebSocket 行为不变。
- 前端按 access token → `/identity/v1/principal-bootstrap:issue` → `/app-server/principal-session/exchange` 顺序请求；两类响应都执行 exact-key、type、size/control-character 校验，bootstrap/session token只存在于当前 Promise 链内，不写 localStorage、URL、日志或 React state。
- 浏览器使用 `Sec-WebSocket-Protocol: crewon.principal-session.v1, <session JWT>`；服务端只回选固定协议名。Authorization 与 subprotocol 双重凭证、额外协议项和 malformed 值均拒绝；非浏览器 Authorization 入口保持兼容。
- Vite 与 production nginx 为 exchange 提供独立 same-origin HTTP proxy 并移除 Origin；既有 `/app-server` WebSocket path 不 rewrite，避免破坏旧客户端。浏览器默认 Gate 实测仍连接真实 app-server并加载办公室数据。
- production blocker 已关闭：Harness 证明 logout 后旧 access 不能再次 mint bootstrap、旧 refresh 不能轮换、logout 前已经签出的 bootstrap 也不能再创建 principal session；legacy no-claim token 在 Gate 开启后 fail-closed，但默认关闭路径仍保持兼容。

## Commands

- Agent Platform identity/auth/Provider Run/contract targeted aggregate：312/312 通过。
- Permission Service 全包回归：12/12 通过。
- Agent Platform targeted `ruff check`、`ruff format --check` 与 strict `mypy`：通过；新 scope-context 窄适配器独立 strict mypy 为 0 issue，不继续扩大历史通用 Permission client。
- Agent Platform identity 模块最终聚合：Ruff、format check、Python 3.12 strict mypy 通过，56/56 tests 通过；包含 access token → bootstrap → resolve → session issue → JWT verify → logout revoke、old-access/refresh/bootstrap replay fail-closed、server-expiry/32-slot reclamation 与 authority expiry clamp E2E Harness。
- principal-session 高触达协调模块已从 840 行收敛到 744 行；auth-session 事务适配与错误映射位于独立 114 行私有模块，避免继续扩大编排模块。
- CrewON `crewon-provider-agent-platform` 全包：47/47 通过。
- CrewON `crewon-state` 全包：173/173 通过。
- CrewON UI：220 test files、1256/1256 tests，TypeScript lint 与 production build 通过；仅有既有 bundle-size warning。
- CrewON `crewon-app-server-transport` 全包：136/136 通过。
- CrewON `crewon-app-server` 全包：1052/1052 通过，另有 1 个按配置 skip。
- CrewON scoped `just fix`：本轮 `crewon-provider-agent-platform` 退出 0；此前 transport/app-server scoped fix 结果保持 Green，新增代码无遗留 lint allow。
- `just fmt`：通过。
- `just bazel-lock-update` 与 `just bazel-lock-check`：通过。
- 跨服务 bytes/SHA verification script：通过，SHA-256 为 `09899f813c9c954a5dbf4b05da51d32fecd464c14e4f0d205bab1e2b7860ac92`。
- 独立进程 live Harness：Permission Service、Agent Platform 与 CrewON app-server 使用隔离 SQLite、独立端口和真实 2048-bit RSA keypairs 启动；logout 后旧 access/refresh/bootstrap 均拒绝，context switch 轮换 epoch 并关闭旧 WebSocket，membership removal 关闭活动 WebSocket，app-server restart 从 authoritative snapshot 拒绝旧 session。
- scope-context 双服务 live Harness：Agent Platform 与 Permission Service 使用不同 JWT secret 仍能成功切换，证明不再依赖跨服务用户 JWT；真实角色 `owner/owner` 与动态变更后的 `admin/developer` 同时进入响应和新 token；tenant mismatch、缺内部密钥、membership removal 均返回 403。
- Provider v3 隔离 live Harness：临时真实 RSA service/delegation/discovery token、独立 Permission Service、真实 MinIO、不可变 AgentVersion 和加密个人模型凭据完成 descriptor/list/read、start/read/events 与受鉴权 artifact read；worker 真实调用 OpenAI-compatible HTTP upstream，Run 从 queued 到 completed，MinIO 22 字节正文及 SHA-256 与数据库/HTTP metadata 一致。临时 DB、key、bucket data、sandbox/container 和端口随后清理。
- Provider fault Harness：运行中 cancel 只产生 `runStarted -> cancelled` 且无 Artifact，同 worker 后续 Run 正常完成；进程 `SIGKILL` 后在不改变 300 秒生产 stale threshold 的前提下模拟 301 秒锁龄，同库重启记录 `stale recovered: 1`，只产生 `failed(unknownOutcome, retryable=false)`。相同 start 幂等重放 `created=false`，upstream 调用仍为 1，没有自动重放或 Artifact。

## Gate

canonical contract、authority、durable auth-session epoch、source API、bootstrap/session issuer、CrewON exchange、浏览器 subprotocol、refresh/listener、前端与 production composition 已接线，但三端显式 Gate 都默认关闭。独立进程 logout/context switch/member removal/restart，以及隔离 Permission/catalog/credential/MinIO、cancel/crash-recovery Provider Harness 已通过；生产 keyset 供应/轮换、完整服务配置与真实云模型验收通过前仍不得打开 Gate，CrewON CloudWorker production registration 继续暂停。
