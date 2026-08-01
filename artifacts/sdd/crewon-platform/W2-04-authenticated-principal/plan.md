# W2-04P Implementation Plan

## Stage D: Discovery（已完成）

1. 审计 RequestIdentity、ConnectionSessionState、WorkspaceRegistry、Credential owner、WebSocket auth 与 RemoteControl client tracker。
2. 确认当前 transport auth 只返回 allow/deny，ConnectionOpened 不携带 auth result。
3. 确认 capability token、initialize metadata、RemoteControl clientId 均不能作为 stable principal。

## Stage P1a: Principal domain + RequestIdentity（已完成）

1. Harness Red：生产类型与 `new_authenticated` 构造入口不存在，测试先失败。
2. 新增 bounded/redacted immutable authenticated principal，不保存 raw token。
3. ConnectionRequestIdentity 可选消费 principal；稳定 actor 与 connection session 分离。
4. 更新 Policy/Credential derivation Harness；不改 WorkspaceRegistry 生命周期。

P1a 以独立小模块落地，未修改 app-server v2 wire shape、WebSocket upgrade、WorkspaceRegistry、Credential 持久化或 CloudWorker production composition。

## Stage P1b: WebSocket verified claims（已完成）

1. transport 定义显式 `TransportAuthentication`：`ConnectionScoped` 或不可由外部构造的 verified principal，避免模糊 `Option` 与 app-server 二次解析 JWT。
2. signed bearer verifier 返回 transport authentication，而不是只有 `()`；complete principal claims 才产生 verified principal。
3. partial/null claims、未固定 issuer/audience、bad time/bounds fail-closed；capability、无 auth、legacy signed token 保持 `ConnectionScoped`。
4. `TransportEvent::ConnectionOpened` 携带 transport authentication；stdio、unix socket、RemoteControl 显式发送 `ConnectionScoped`。
5. app-server 只把 verified transport principal 映射为 P1a principal，不接触 raw bearer token，也不信任 initialize metadata。
6. WebSocket 连接所有者根据 verified `expiresAt` 取消自身 disconnect token；自然关闭和 expiry 统一发出 `ConnectionClosed`。

P1b 不改变 app-server v1/v2 wire shape，不持久化 principal，不迁移 WorkspaceRegistry，也不实现 revoke。旧 signed bearer token 继续可连接，但只能获得 connection-scoped authority。

## Stage P1c: Revoke + RemoteControl（production composition 已完成，默认关闭）

1. 新增 bounded/redacted transport revocation registry：exact source + issuer + JTI key、expiry retention、幂等 publish、subscribe-before-snapshot 和 lag recovery。
2. WebSocket upgrade 与活动连接共同消费 registry：已撤销 token 拒绝建立 session，活动的同 JTI 连接被主动关闭；容量溢出 fail-closed，不能丢撤销事件后继续授权。
3. 保留现有 `start_websocket_acceptor` 兼容入口；增加显式接收 registry/exchange 的组合入口，由默认关闭的 Agent Platform production composition 注入。
4. `account/logout` 只管理 ChatGPT/model auth，`remoteControl/client/revoke` 只管理 controller capability，二者均不接到 WebSocket principal registry。
5. RemoteControl 当前上游 envelope 缺少签名 user/tenant/space/JTI/expiry 与 revoke feed，因此继续 `ConnectionScoped`；只冻结未来最小上游 contract，不添加无效 wire 字段。

P1c-1 已满足 exact event contract、竞态安全 registry、WebSocket selective disconnect、启动前 authoritative snapshot/immediate catch-up、gap-free cursor 和 freshness-loss fail-closed。Agent Platform bounded durable auth-session family/epoch/server-expiry、expired-slot reclamation、authority expiry clamp、logout/context switch hook 与前端 bootstrap/exchange/reconnect 已接入，独立进程 restart/live 身份生命周期，以及隔离 Provider v3 live/cancel/crash Harness 已通过；生产 keyset 轮换、完整服务配置和真实云模型尚未完成，因此 production Gate 继续关闭。

## Stage P2: Durable authority migration

1. [x] Credential owner derivation 改用 authenticated principal 稳定 actor；旧 connection-scoped owner 不获得 durable Provider authority。
2. [x] P2b-1 实现固定 Agent Platform 的 durable identity mapping、active uniqueness、terminal revoke、CAS 与 reopen Harness；不改 WorkspaceRegistry 生命周期，也不注册外部入口。
3. [x] P2b-2a 实现 app-server internal read resolver，证明 authenticated principal、RequestIdentity、active mapping 与 Credential owner exact match，并构造 P2a identity；保持未注册。
4. [x] P2b-2b 在 Agent Platform 实现 authoritative exact resolve/read、terminal revoke 与 60 秒 freshness；P1c 单独负责 session/JTI gap-free revoke，不使用测试 fixture或客户端 claim代替。
5. [x] P2a 实现真实 RS256 service/delegation/discovery token issuer，并绑定 exact Credential revision；保持未注册。
6. [ ] source freshness、隔离 live smoke 与 cancel/crash 故障演练已通过；完成生产 key/config 轮换和真实云模型验收后再解锁 W2-04 Provider/Resource API 和 W2-07 production composition。

## Gate

P1a 只建立正确身份语义，不单独解锁任何生产功能。P1b/P1c 的 expiry/revoke/reconnect 全部通过，并且 P2 owner migration 有 restart Harness 后，才允许 W2-04、W2-08 或 CloudWorker production registration。
