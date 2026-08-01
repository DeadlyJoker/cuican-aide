# W2-04P Verification

状态：Discovery、设计冻结、P1a/P1b、P1c transport/source contract、Agent Platform durable auth-session family/epoch、principal-session/revoke/bootstrap source、CrewON exchange/browser subprotocol/RS256 verifier/listener、P2a 未注册 RS256 issuer、P2b durable identity mapping/exact refresh、前端接线，以及默认关闭的 production composition 已完成；独立进程身份生命周期/restart，以及隔离 Provider v3 discovery/run/artifact、cancel 和 worker crash/restart Harness 已通过。生产 keyset 轮换、完整服务配置和真实云模型尚未完成，production Gate 保持关闭。

## Discovery 基线

- `ConnectionRequestIdentity::new` 每次连接生成新 UUID，并直接由 session 派生 actor/audit subject。
- P1a 前 `RequestIdentityRef.tenantId/spaceId` 始终为 null；无 authenticated principal 的连接仍保持该行为，Credential owner 仍使用 connection actor。
- WorkspaceRegistry owner 是 sessionId，registry 本身只存在 ConnectionSessionState 内。
- WebSocket `authorize_upgrade` 返回 `Result<(), ...>`；`JwtClaims` 只有 exp/nbf/iss/aud。
- `TransportEvent::ConnectionOpened` 只携带 connectionId/origin/writer/disconnect sender。
- capability token只能证明 shared token possession；RemoteControl clientId/streamId 由远端 envelope提供，均不是用户身份。

## P1a Red

- 先增加 authenticated principal 与稳定重连 Harness。
- `just test -p crewon-app-server authenticated_principal` 按预期编译失败：`platform_control::authenticated_principal` 模块与 `ConnectionRequestIdentity::new_authenticated` 尚不存在。
- Red 证明测试依赖的是待实现的生产接口，不是伪造测试内实现。

## P1a Green

- 新增 immutable `AuthenticatedPrincipal`：固定来源、issuer/audience/subject/tenant/space/JTI/issuedAt/expiresAt，所有字符串均有非空、trim、控制字符和 byte cap 校验，生命周期硬上限为 1 小时。
- raw token 从未进入 principal；`Debug` 对 issuer/audience/subject/tenant/space/JTI 和稳定 actor 全部脱敏。
- 稳定 actor 使用 domain-separated SHA-256(`issuer`, `subject`)；tenant/space 分别进入既有 `PolicyActor` 与 `CredentialOwner` 派生。
- 同 principal 重连时 actor、PolicyActor、CredentialOwner 稳定；session、trace、audit subject 保持连接隔离。
- subject/issuer/space 改变时不能复用旧 authority；identity projection 只暴露既有 opaque actorId、tenantId、spaceId，不暴露 issuer、subject 或 JTI。
- 没有修改 v1/v2 RPC、schema、TransportEvent、WebSocket verifier、WorkspaceRegistry 或 Credential 持久化。

## P1b Red

- 先增加 transport principal Harness；`just test -p crewon-app-server-transport principal_tests` 按预期编译失败，缺少 `TransportAuthentication`、`TransportAuthenticatedPrincipalSource` 和可注入时钟的 verifier。
- 端到端 reconnect Harness 第一次运行因测试未 opt-in experimental `identity/read` 而等待到 token 到期；连接随后被服务端断开，证明 expiry 路径工作。Harness 改为真实 experimental initialize，没有放宽 API Gate。
- expiry Harness 第一次遇到异步 `configWarning` 通知；Harness 改为忽略普通文本通知并继续等待关闭，仍以超时作为失败条件。

## P1b Green

- transport 新增显式 `TransportAuthentication::{ConnectionScoped, AuthenticatedPrincipal}`，避免用模糊 `Option` 表达授权来源；verified principal 无 public constructor。
- capability token、无 auth、legacy signed bearer、unix socket、stdio 和 RemoteControl 均保持 connection-scoped；RemoteControl/unix Harness 显式断言该事实。
- signed bearer 只有在服务端固定 issuer/audience，并完整提供 `sub`、`tenantId`、`spaceId`、`jti`、`iat`、`exp` 时才产生 principal。
- 任一 principal claim 出现但缺失、为 null、越界、含控制字符、时间倒置、过期、未来 iat 超 skew 或生命周期超过 1 小时，upgrade fail-closed。
- raw bearer token 不进入 transport event；transport/app-server principal 均无 Serialize，并使用脱敏 Debug。WebSocket auth policy Debug 只显示 mode，不显示 secret、hash、issuer 或 audience。
- `ConnectionOpened` 携带 server-owned transport authentication；app-server 二次校验 principal bounds 与 source/origin 一致性后才构造稳定 RequestIdentity。
- upgrade 后到 `ConnectionOpened` 前恰好过期的 principal 不建立 session；已建立连接在 `expiresAt` 到达时取消自身 disconnect token并统一发送 `ConnectionClosed`。
- 同 token 重连端到端验证 actor/tenant/space 稳定，session/trace/audit subject 轮换；identity projection 不暴露 issuer、subject 或 JTI。
- 没有修改 app-server v1/v2 RPC shape、协议 schema、WorkspaceRegistry 生命周期、Credential 持久化或 CloudWorker production composition。

## 测试与静态检查

- `just test -p crewon-app-server authenticated_principal`：4/4 通过。
- `just test -p crewon-app-server platform_control`：18/18 通过。
- `just test -p crewon-app-server`：1032/1032 通过，1 个 slow，1 个按配置 skipped。
- P1a 生产模块 132 行、测试 175 行；修改后的 `request_identity.rs` 204 行，均低于模块规模上限。
- `git diff --check` 通过。
- `just fix -p crewon-app-server` 通过；5 个 warning 均来自既有 `crewon_domain_processor` / `agent_platform_processor` 路径，P1a 模块没有新增 warning。
- 最终 `just fmt` 通过；按仓库规则未在 fix/fmt 后重复测试。

## P1b 测试与静态检查

- transport principal Red 后 Green：4/4 通过；加入 auth policy Debug 兼容/脱敏 Harness 后 5/5 通过。
- `just test -p crewon-app-server-transport`：118/118 通过；新增 Debug Harness 随后的 targeted 5/5 通过。
- `just test -p crewon-app-server connection_authenticated_principal_websocket`：2/2 通过。
- `just test -p crewon-app-server connection_handling_websocket`：15/15 通过。
- `just test -p crewon-app-server platform_control`：18/18 通过。
- `just test -p crewon-app-server`：1034/1034 通过，1 个按配置 skipped。
- `auth.rs` 生产部分在 test module 前为 493 行；principal/claims/端到端 Harness 均拆为独立小模块。
- `git diff --check` 通过；未修改依赖或 app-server protocol，无需生成 schema/lockfile。
- `just fix -p crewon-app-server-transport` 通过并应用 1 个机械 clippy 修复；`just fix -p crewon-app-server` 通过，5 个 warning 均来自既有 processor 路径。
- fix 首次因本仓库 58GB incremental cache 挤满磁盘而失败；仅删除可再生的 `codex-rs/target/debug/incremental` 后重试成功，源码、DB 与工作区数据未受影响。
- 最终 `just fmt` 通过；按仓库规则未在 fix/fmt 后重复测试。

## P1c Red / Green

- Red Harness 先引用尚不存在的 `principal_revocation` 模块；`just test -p crewon-app-server-transport principal_revocation` 按预期因 unresolved import 失败，证明测试依赖生产 contract。
- 新增 exact `(source, issuer, JTI)` in-memory registry；最多保留 4096 条到 verified expiry，event channel 固定 128。容量耗尽时清空 key map并 fail-closed 到已知最大 expiry，不能静默丢 revoke。
- subscription 在读取 authoritative snapshot 前先订阅；revoke-before-subscribe、subscribe/check 竞态、broadcast lag 都由 snapshot 恢复。重复 revoke 幂等，expired entry 自动清除；source freshness 丢失可永久 fail-closed 并唤醒全部 authenticated subscription，恢复必须使用新 registry/listener 重载 authoritative snapshot。
- WebSocket upgrade 拒绝已撤销 principal；subscribe 后到 `ConnectionOpened` 前撤销不会创建 session；活动连接按 exact key 关闭，同 JTI 的全部连接关闭，不同 issuer/JTI 保持运行。
- 保留原 `start_websocket_acceptor`；新增显式 registry/exchange composition entry。Agent Platform source API 与 CrewON listener 在 Gate 启用时要求启动前执行 snapshot + immediate catch-up，随后以 1 秒间隔、5 秒 source deadline 维护 cursor；任何 stream/watermark/cursor/source freshness 丢失永久 fail-closed。默认 Gate 关闭，不伪造 identity source。
- RemoteControl envelope 审计确认没有签名 principal proof 或 revoke feed，client tracker 继续显式发送 `ConnectionScoped`；没有把 ChatGPT `account/logout` 或 controller device revoke误接为 principal logout。
- `--ws-max-clock-skew-seconds` 增加 300 秒硬上限，revocation retention 上限为 1 小时 token 生命周期 + 5 分钟 skew。

## P1c 测试与 review

- `just test -p crewon-app-server-transport revocation`：8/8 通过。
- `just test -p crewon-app-server-transport`：136/136 通过。
- `just test -p crewon-app-server connection_authenticated_principal_websocket`：2/2 通过。
- `just test -p crewon-app-server connection_handling_websocket`：13/13 通过。
- `just test -p crewon-app-server`：1052/1052 通过，1 个按配置 skipped。新增 exchange、production composition、bounded key-file reader 与 revoke listener Harness 均包含在包级回归中。
- 新增 revocation 生产模块约 410 行，WebSocket 生产文件在 test module 前低于 500 行；均未把协调逻辑继续堆入 app-server central loop。
- 没有修改 app-server v1/v2 wire、schema、依赖或 lockfile；新 acceptor 是 additive Rust API。唯一有意收紧是拒绝大于 300 秒的 signed-bearer clock-skew 配置。

## P2b-1 Red / Green

- Red Harness 先引用不存在的 Provider identity record/runtime API；`just test -p crewon-state provider_identity` 按预期因 unresolved types/methods 失败，证明测试依赖待实现的生产端口。
- migration `0040_provider_identity_bindings.sql` 只新增内部 State 表。provider 固定为 `agent-platform`，数据库 partial unique index 同时约束 active local owner 和 exact external target，`(authorityId, sourceBindingId)` 终身唯一。
- record 只接受 canonical `principal:<64 lowercase hex>`、`user:<positive integer>` 与 positive provider tenant/space；所有 ID 有 byte cap、trim/control-character 校验，revision/time 有 SQLite range 约束。
- record hash 使用 domain-separated SHA-256 覆盖 owner、target、source、revision、status 与时间；读路径重新校验完整 record，Debug 脱敏 owner、provider identity 与 authority。
- create/revoke 使用 `BEGIN IMMEDIATE`。create 支持 exact replay，owner/target/source 冲突 fail-closed；revoke 要求 expected revision、相同 authority、严格递增 source revision 和非回退时间，terminal 后只允许 exact idempotent replay。
- Harness 覆盖 active owner/target 冲突、source binding 撤销后不可复用、同 owner 并发创建只有一个 winner、terminal revoke、stale revoke、new binding rebind，以及 active/revoked close/reopen deep equality。
- P2b-1 没有新增 app-server v1/v2 RPC、CLI/config、WorkspaceRegistry 持久化或 P2a/CloudWorker 注册；它不能自行证明 identity-session authority 或 Credential owner ownership。

## P2b-1 测试与 review

- `just test -p crewon-state provider_identity`：5/5 通过。
- `just test -p crewon-state`：171/171 通过，0 skipped。
- 生产模块按职责拆分：record/validation 390 LoC、transaction runtime 287 LoC，均低于 500 LoC；测试位于两个 sibling test 文件。整体 review 可按“record + migration”和“runtime + Harness”两个独立 coherent stage 检查，避免一次评审混合数据契约与事务行为。
- shared `crewon-state` 已完成包级验证；workspace-wide `just test` 仍需按仓库规则获得用户许可后单独运行。
- production Gate 保持关闭：P2b-2b 已接入真实 exact identity source、bounded freshness 与 durable auth-session epoch；仍需真实配置、跨服务 restart 和 live Provider smoke，P2b-2a 继续只在签发前证明 authenticated principal、local tenant/space、Credential owner 与 fresh active mapping exact match。

## P2b-2a Red / Green

- Red Harness 先引用不存在的 `platform_control::provider_identity_adapter`；`just test -p crewon-app-server provider_identity_adapter` 按预期因 unresolved module 失败。
- 新增 83 LoC app-server internal resolver，只读 `StateRuntime` active mapping，不提供 create/revoke/RPC/CLI/config 或 worker registration。
- resolver 要求 verified authenticated principal，并交叉校验 principal stable actor/tenant/space 与 `RequestIdentityRef`；connection-scoped identity、scope drift 和 principal projection drift fail-closed。
- resolver 重新派生当前 `CredentialOwner` 并与调用方 owner deep equal，再用 exact actor/tenant/space 查询 fixed Agent Platform mapping；cross-space、missing、revoked 或存储错误都不能产生 Provider authority。
- mapping target 最后仍通过 `ProviderAuthorizationIdentity::new` 的 canonical positive identity 校验；adapter error 为无 payload 的闭集，不回传 owner、provider subject、scope 或数据库错误。

## P2b-2a 测试与 review

- `just test -p crewon-app-server provider_identity_adapter`：3/3 通过。
- `just test -p crewon-app-server`：1037/1037 通过，1 skipped。
- adapter 83 LoC、sibling Harness 201 LoC；没有新增依赖、app-server v1/v2 wire、schema、WorkspaceRegistry 持久化或生产 composition。
- Agent Platform authoritative identity source、bounded durable auth-session family/epoch、bootstrap/session issuer、lifecycle revoke hook 与 CrewON exact refresh/exchange 已实现；只有携带当前 authSessionId/authEpoch 的 access token 才可换取短期 assertion，legacy token 不能直接或间接成为 WebSocket principal。

## Production composition evidence

- Agent Platform `IDENTITY_SOURCE_ENABLED` 与 CrewON `CREWON_PRINCIPAL_SESSION_ENABLED` 均默认 false，值非法或启用配置不完整会在启动前失败。
- CrewON production mode 拒绝 loopback/非 HTTPS endpoint；显式 development-loopback 只用于本地。私钥文件必须是绝对路径、非 symlink，Unix 下不得对 group/other 开放。
- CrewON 在 WebSocket bind 前预载 authoritative revoke snapshot + immediate catch-up；listener 或 acceptor 启动失败会取消兄弟任务，listener freshness 丢失后连接 fail-closed。
- in-process E2E 与独立进程 Harness 已证明 access token → bootstrap → exact resolve → session issue → RS256 verify → logout revoke，logout 后旧 access/refresh/bootstrap fail-closed，context switch/member removal selective disconnect，restart snapshot 拒绝旧 session。
- 隔离 Provider v3 Harness 使用临时真实 RSA authority、Permission、Catalog/materialization、加密个人模型凭据、OpenAI-compatible HTTP upstream 与 MinIO，证明 descriptor/list/read、durable start/read/events、completed output 和鉴权下载闭环。
- fault Harness 证明运行中 cancel 不产生 output、同 worker 可继续执行；`SIGKILL` 后同库重启按生产 300 秒 stale threshold 恢复为 `unknownOutcome`，相同 start 只返回原 Run 且 upstream 不重放。剩余证据仅是生产 keyset/config 轮换和真实云模型验收。
- server-expiry Harness 证明 refresh/context switch 只滑动当前 login family，填满 32 个 slot 后到期前拒绝新增、到期后原子转为 expired 并回收容量；短 family lifetime 下 bootstrap 与 principal session 的 `exp` 都被钳制到同一到期点。
- 前端全套 220 个 test files、1256/1256 tests，TypeScript lint 与 production build 通过；浏览器默认 Gate 实测真实 app-server保持连接。subprotocol JWT 只在 WebSocket 构造时存在内存，不进入 URL/storage。
- auth replay 硬阻断已关闭：login family 有 server-owned epoch/expiry，refresh 保持 exact family/context 并滑动续期，bootstrap 携带 authSessionId/authEpoch，session issue 按固定锁序重验且 authority 不得活过 family；旧 no-claim token 在 Gate 启用后不能 bootstrap 或 refresh。

## Gate 结论

P1a/P1b/P1c、durable auth-session epoch、P2b exact source/refresh、bootstrap/session exchange、浏览器 subprotocol、前端与受监督 production composition 已建立稳定身份、可信 WebSocket claims、expiry/revoke selective disconnect、启动 snapshot/catch-up、gap-free cursor supervisor 和 RemoteControl no-principal Gate。独立进程 logout/context switch/member removal/restart，以及隔离 Provider v3 live/cancel/crash Harness 已通过；默认运行继续由环境 Gate 关闭，生产 keyset 供应/轮换、完整服务配置和真实云模型未完成，因此仍不能开放 durable reconnect 或 Provider/CloudWorker production composition。
