# W2-04 Verification

状态：W2-04 implementation Gate Green。Authenticated Principal、真实 revoke/source freshness、durable CredentialOwner/Provider identity/workspace/connection/Access Grant/Resource Binding、principal-exchange provisioning、composite lifecycle resolver、grant-aware processor、deterministic secret-free projection、production factory/startup readiness、live Catalog、experimental Provider/Resource v2 RPC/schema/TestAppServer 和 current-connection-only binding notification 已完成。client-selected Credential processor 在 production review 中被判定首连不可达并已撤回；完整 workspace release evidence 仍等待用户明确授权。

## 证据

- W1-01 spec 明确同一连接 actor/session 稳定、重连后变化，当前没有可信 user/member/credential owner。
- W1-02 spec 明确 workspaceKey/bindingId 为 connection-session 生命周期，跨 session key 拒绝且不持久化。
- W1-03/W1-10 adapter 使用 `RequestIdentity` actor/tenant/space 派生 Credential owner，并对 owner mismatch fail-closed。
- 完整 WebSocket signed principal 现已把 verified subject/tenant/space 注入 app-server RequestIdentity，并通过 reconnect 与 expiry disconnect Harness；capability/legacy/RemoteControl 仍保持 connection-scoped。
- transport 已有 bounded revocation registry、WebSocket selective disconnect 和 RemoteControl no-principal Gate；Agent Platform authoritative source、logout/context/membership revoke、CrewON listener/exchange 与 RS256 issuer kernel 已完成。
- CredentialOwner 与 Provider identity 已随 authenticated principal/fresh mapping 稳定；verified principal 的 WorkspaceRegistry 现在从 State 恢复 stable key，connection-scoped transport 仍保持 session random。
- `W2-04-durable-workspace` State kernel 以 0042 migration 保存 path-free root fingerprint 到随机 workspaceKey 的 immutable mapping；5/5 targeted、178/178 `crewon-state` 全包、scoped fix/fmt 通过。
- app-server adapter 在真实 signed-bearer WebSocket process restart 后恢复相同 workspace projection；catalog removal、并发首次 refresh、path-free serialization 与普通连接隔离均有回归 Harness。
- `W2-04-provider-connection` 以 0043 migration 保存 secret-free immutable owner/provider/protocol/credential selection；targeted 5/5、`crewon-state` 183/183、scoped fix/fmt 通过。
- A1a 保留 read/list/read/bind/unbind 与 projection notification DTO；read 只接受 server-owned `connectionId`，bind 不接受 endpoint、owner、workspace root 或 execution location。要求客户端提交 `providerId + credentialId + exact revision` 的 connect selection DTO 已撤回。
- `ResourceType` 与 Federation 精确对齐为 Agent、Skill、McpServer、McpTool、KnowledgeBase、Workflow；旧的 lossy `mcp`/`knowledge` wire 值 fail-closed。
- DTO 直接 `schemars`/`ts-rs` Harness 与完整 `crewon-app-server-protocol` 242/242 通过。A1b 已在真实 processor/startup runtime Green 后注册 experimental `provider/connect/read`，方法级 experimental schema 可生成，最终 vendored stable fixture 继续过滤 experimental surface。
- prototype processor 曾证明 verified principal、cross-owner、Credential/mapping 双检与 live descriptor drift 可以 fail-closed；但它只能由 FakeCredentialStore 预造 selection，production 没有首连 provisioning。为避免把测试内可达误标成产品可达，processor/projection adapter 和 selection DTO 已撤回。
- Agent Platform code review 证明 Provider Run delegation credential 是 CrewON authorization binding；真实个人/NewAPI model key 由 Agent Platform `materialized_credentials` 服务端解析。下一实现必须使用 Secret-free Provider Access Grant，而不是把占位 Secret 写入 `LocalCredentialStore`。
- principal-session exchange 现在在返回 session 前持久化 authoritative resolve 的 exact Provider identity mapping；targeted 4/4 覆盖正常持久化与 owner drift 不落权威。
- 撤回后重新生成 schema：protocol 241/241；Provider production targeted 2/2；完整 app-server 1059/1059 通过，1 skipped。两项既有 Unix signal timing case 首轮超时、nextest retry Green，标记 flaky 且与本切片无调用关系。
- Access Grant Stage A 已新增 0044 Secret-free State kernel：active owner/source 双唯一、bounded scopes/hash、exact replay、CAS revoke、原子 replace、expiry lookup、tamper/capacity fail-closed；targeted 7/7、state 190/190、app-server migration smoke 4/4 与 Bazel query 通过。
- Access Grant Stage B provisioner 已接入 principal-session exchange，签发服务端固定且严格排序的 `provider.discovery`、`providerKnowledge:search`、`providerTool:call` 集合，并绑定 exact owner/source revision 与 issued session expiry；客户端不能提交或扩大 scope。W2-05 的 targeted provisioner 3/3、principal exchange 4/4 通过。Grant 失败不向客户端返回 session token，并发/重复 exchange 收敛；不使用 Secret-bearing `CredentialStore`。
- Access Grant composite resolver 复用 fresh identity adapter并 exact 查询未过期 Grant，scope 必须与固定集合完全相等；2/2 lifecycle Harness 覆盖 restart/replay、无认证/logout 后请求、context switch、source drift、expiry 与 mapping revoke。每次 Provider Tool/Knowledge 外部执行仍使用单资源/单操作短期 delegation。
- lifecycle resolver 切片完成时 `crewon-app-server` 全包 1064/1064 通过，1 skipped；两个 Unix signal 与一个既有 Office auto-dispatch case 首次时序失败、nextest retry Green，新增 grant/principal 用例无失败。
- 未注册 Provider connection processor 只消费 providerId/connectionId，在 live descriptor I/O 前后双检 composite authority，并使 persisted connection 对旧 grant/cross-owner/protocol drift fail-closed；targeted 3/3、最新 app-server 1067/1067 通过，1 skipped，无 flaky。
- projection adapter 移除未注册 DTO 中的 CredentialRef，显式映射 capabilities，并以不含 observedAt 的 canonical content hash 生成 ETag；targeted 2/2、protocol 241/241、最新 app-server 1069/1069 通过，1 skipped。
- startup runtime 已在任何 transport accept 前接入：默认关闭/配置移除返回无 runtime；显式启用要求 SQLite State + principal identity reader，并先 bounded refresh 全部 active mappings。targeted 3/3、当时 app-server 1072/1072 一次通过，1 skipped、3 slow。该阶段没有提前增加 wire surface。
- Provider RPC Stage D 新增独立 90 LoC request processor，`MessageProcessor` 只做机械路由和 runtime 注入。connect/read Params 分别只有 `providerId`/`connectionId`，未知 credential/owner/endpoint 字段在 dispatch 前拒绝；runtime 错误映射不回显内部 authority。真实 descriptor + sqlite + mapping/grant Harness 覆盖 connect/read 与 forged provider，TestAppServer 覆盖 experimental gate、disabled runtime 和 authority 字段拒绝。
- Stage D targeted Provider 15/15、完整 protocol 242/242、完整 app-server 1077/1077 通过，1 skipped、1 slow、1 个既有 Office startup timing case 自动重试 Green。`just write-app-server-schema --experimental` 验证方法导出，最终 `just write-app-server-schema` 恢复 stable fixture；两个 scoped fix 与 final fmt 通过，app-server 仅有 5 条既有 unrelated warning。
- Resource Catalog Stage E 抽出共享 connection begin/finish authority validation，并用一次 pinned、RS256-authorized catalog session 同时持有 strict descriptor 与执行 list/read；I/O 后 authority 漂移、grant revoke、cross-owner、protocol/kind/resource mismatch 均 fail-closed。
- `resource/list` 默认 limit 20、接受 1..=100、cursor opaque；Agent Platform Provider 自身继续收紧到 50。`resource/read` 从 connection 补齐 protocolVersion，并要求 exact provider/type/id/revision manifest 回读。
- Stage E 独立 request processor 85 行、error Harness 41 行、TestAppServer 124 行；中心只机械路由。experimental schema 包含两个方法，最终 stable fixture 排除它们。Resource targeted 5/5、真实 RS256 request processor 1/1、protocol 242/242、app-server 1082/1082 Green，1 skipped、1 slow、2 个既有 timing case retry Green；scoped fix/final fmt 通过。
- Resource Binding B1 新增 strict hash-bound record、0045 additive migration 与独立 415 行 State runtime；resolve 在同一事务内重验 connection owner/provider/protocol 和 durable workspace existence，相同 selection 并发收敛，unbind 后 rebind 复用原 bindingId 并 CAS revision。owner-scoped unbind 对 missing/cross-owner 返回 NotFound，并覆盖 tamper/capacity/unbind-reactivate 竞态。targeted 8/8、`crewon-state` 198/198 Green，0 skipped；StateRuntime reopen 覆盖 migration smoke。
- Resource Binding B2 增加 session-owned/path-free Workspace proof resolver、pinned live Catalog exact read、Federation capability resolver、strict State adapter、State-only unbind、experimental bind/unbind RPC 和 current-connection-only notification。localSnapshot/localFork 在无 materializer 时 fail-closed；cross-owner/missing 隐藏为 NotFound，客户端 authority 字段在 dispatch 前拒绝。
- B2 targeted Workspace 1/1、adapter/core 5/5、TestAppServer 3/3；protocol 242/242、app-server 1088/1088 Green，1 skipped。2 个既有 timing case retry Green，新 Binding 用例无失败。experimental schema 含 bind/unbind/updated，stable ClientRequest fixture 排除 bind/unbind。
- production config 审计确认旧 `CREWON_AGENT_PLATFORM_BASE_URL/API_KEY` 属于 client-token/history processor，不能复用为 server-owned Provider v3 authority；`CREWON_IDENTITY_SOURCE_URL` 又严格绑定 `/identity/v1/`。因此 A2b 采用独立的 `/provider/v3/` endpoint、endpoint mode 与 Provider Run RS256 signing key，不从旧 API key 或 identity-source URL 隐式派生。
- A2b factory 现在只接受显式 `CREWON_PROVIDER_AGENT_PLATFORM_*` enable/url/mode/key 配置，默认关闭；旧 Open API 配置不启用它，identity-source 路径、部分配置、模糊开关与无效 private key 均 fail-closed。
- factory 复用 W2-03 `ProviderEndpointPolicy`/pinned client、strict descriptor 与 RS256 authorizer；私钥文件复用 hardened bounded/private-file reader，owned PEM 缓冲在解析后清零，解析后的 key 只在进程内共享。
- 每次 descriptor read 使用 current mapped Provider identity 创建 authorizer；live Harness 验证 bearer/delegation headers、descriptor capability 投影和 Debug/body secret redaction。targeted 2/2、Provider adapter 48/48、app-server 1061/1061 通过，1 skipped；Bazel app-server query 通过。

## 结论

W2-04 的身份、revoke、Credential/Provider authority、durable workspace/connection/grant/resource binding、live Catalog、projection、startup readiness、experimental Provider/Resource RPC 与定向通知已经形成闭环，implementation Gate Green。W2-05 Dynamic Tool Router 与 W2-06 UI Provider/Resource 可进入各自独立 SDD/Red Harness；W2-08 仍等待 W2-05、W2-06、W2-07。完整 workspace `just test` 未获授权，因此不把当前结论扩大为 repo-wide release Gate 或 Cloud Agent 生产切换。
