# W2-04PC Verification

状态：设计审查、State Red/Green、Access Grant State + discovery-only provisioning + composite lifecycle resolver、processor、deterministic secret-free projection adapter/resource DTO、默认关闭的 production Provider factory/config kernel、startup readiness composition、experimental provider/connect/read，以及 live catalog resource/list/read RPC/schema/TestAppServer 完成；client-selected Credential processor 经 production review 已撤回。Durable Resource Binding 与 projection notification 尚未实现。

## 已确认问题

- protocol `ProviderRef` 包含 kind/status/capabilities，`CredentialRef` 包含 provider/scope/status/expiry/revision；二者是投影，不是安全 selection Params。
- authenticated principal、Credential owner、Provider identity mapping 与 durable workspace 已稳定，但没有 Provider connection record 或可跨 process 读取的 connectionId。
- Provider client descriptor/capabilities 是 live external fact，不应持久化后被当作 authority；持久化只需要 owner/provider/protocol/credential exact selection。

## DTO Red / Green

- client-selected Credential connect Params 已撤回；Agent Platform 最终 Params 只允许 providerId，exact grant 由服务端解析。
- read/list/read/bind/unbind 使用 server-owned connection/binding ID 和 exact ResourceRef；客户端不能提交 execution location、workspace key/root 或 owner。
- ResourceType 使用 Federation 的精确 kind，拒绝 lossy `mcp`/`knowledge`。
- 直接 schemars/ts-rs Harness 证明 projection contract 不含 endpoint/owner/Secret/root path；schema 重新生成后完整 protocol package 241/241 通过，stale `ProviderCredentialSelection` TS/schema export 已消失。
- 方法级 experimental JSON/TS schema 已随真实 RPC 注册生成验证；最终 vendored stable fixture 按 experimental gate 过滤方法与 Params，避免扩大稳定 API。

## Processor Review

- prototype 曾覆盖 authenticated principal、cross-owner、Credential/mapping双检、live descriptor drift 与 secret-free projection。
- review 发现所有 Green case 都由 FakeCredentialStore 在测试内预造 credential。production 没有对应 create/list/provisioning，客户端第一次 connect 无法获得合法 id/revision。
- Agent Platform 又明确自行解析真实模型 Secret，向 CrewON LocalCredentialStore 写入占位 Secret 既无价值又扩大敏感面。
- 因此 prototype processor、projection adapter 与 selection DTO 已删除；后续只按 Secret-free Provider Access Grant 重建，不保留兼容分支。
- 删除后的 production factory targeted 2/2、完整 app-server 1059/1059 通过，1 skipped；两项既有 Unix signal timing case 首轮超时后 nextest retry 通过并标记 flaky。
- production config 审计证明旧 Agent Platform Open API base URL/API key 与 identity-source `/identity/v1/` 配置都不是 Provider v3 authority；factory 只接受显式 `/provider/v3/` endpoint、endpoint mode 与 Provider Run RS256 key，不能复用客户端 token 或猜测 URL。

## Production factory Red / Green

- Red Harness 先引用不存在的 production module、connector 与 shared signing-key constructor，按预期编译失败。
- 新配置以 `CREWON_PROVIDER_AGENT_PLATFORM_ENABLED` 显式启用，默认关闭且只接受精确 `true`/`false`；启用后的缺项、未知 mode、错误 Provider 路径和无效私钥全部 fail-closed。
- `CREWON_AGENT_PLATFORM_BASE_URL/API_KEY` 不会隐式启用新 factory；`/identity/v1/` 不能替代 `/provider/v3/`。
- production connector 复用 `crewon-provider-transport` 的 production HTTPS/SSRF/DNS pinning policy；development loopback 只由显式 mode 启用。
- 私钥文件复用 principal production 的 bounded/private-file reader；owned PEM 源缓冲由 `Zeroizing` 清零，process 内只共享解析后的 signing key，不为每个 principal 重读 Secret。
- 每次 descriptor read 按 exact mapped subject/tenant/space 创建 identity-scoped authorizer；真实 HTTP Harness 验证 service bearer 与 delegation header 存在，而请求正文、factory Debug 不含私钥、identity 或 legacy Secret。
- connector 先读取并验证 strict descriptor；未知 provider、协议/descriptor 漂移和 external error 均 fail-closed 映射，不产生 cached authority。
- Provider adapter 的资源列表增加 exact response cardinality 回归断言，防止后续 Resource API 重复投影 Provider 条目。
- targeted production factory 2/2、完整 `crewon-provider-agent-platform` 48/48、完整 `crewon-app-server` 1061/1061 通过，1 skipped。
- `bazel query '//codex-rs/app-server:*'` 通过，跨 package RSA fixture 已由 `app-server/BUILD.bazel` 的 test data 明确声明。

## RPC Red / Green

- Red Harness 先注册方法级协议测试并引用不存在的 `ProviderConnectParams`/request processor，分别按预期因缺失 wire Params 与 production processor 失败。
- `provider/connect` 和 `provider/read` 是 experimental v2 方法、无全局串行化；Params 只接受 `providerId`/`connectionId` 并拒绝未知 authority 字段。`MessageProcessor` 从 transport-derived `RequestIdentity` 机械转发，业务逻辑留在独立 request processor。
- runtime error 在 request processor 边界穷举映射；invalid、unauthorized/not-found、incompatible 与 unavailable 分类不包含 grant、source、owner、endpoint、scope 或 Provider 原始错误。
- 真实 runtime Harness 2/2 覆盖 descriptor + sqlite + mapping/grant 的 connect/read、unknown provider 与 disabled runtime；TestAppServer 3/3 覆盖方法注册、experimental gate、authority 字段拒绝和 disabled runtime fail-closed。
- targeted Provider 15/15、protocol 242/242、app-server 1077/1077 通过，1 skipped、1 slow、1 个既有 Office timing case retry Green；experimental/stable schema generation、scoped fix 与 final fmt 通过。

## Resource Catalog Red / Green

- app-server 私有 catalog factory/session 复用 pinned connector、RS256 authorizer 与 `AgentPlatformProviderClient`，一次操作只连接一次并共享 strict descriptor，不做 provider/read + resource I/O 双连接。
- list/read 复用 connection owner/grant/mapping 的 I/O 前后双检；limit/cursor/kind、exact ResourceRef/manifest、provider ETag 和 authority drift 均有 Harness。
- experimental `resource/list` / `resource/read` 通过独立 request processor 注册；TestAppServer 覆盖 experimental gate、disabled runtime 与客户端 authority 字段拒绝。
- Resource targeted 5/5、真实 RS256 request processor 1/1、protocol 242/242、app-server 1082/1082 通过，1 skipped、1 slow、2 个既有 timing case retry Green；experimental/stable schema generation、scoped fix 与 final fmt 通过。

## 未验证

- Resource Binding persistence 与 projection notification。

## State Red / Green

- Red：新增 sibling Harness 先引用不存在的 `ProviderConnectionRecord`、resolve outcome 与 StateRuntime methods；`just test -p crewon-state provider_connection` 按预期因 unresolved production API 编译失败。
- migration `0043_provider_connections.sql` 只保存 immutable owner/provider/protocol/credential exact selection；不保存 endpoint、Secret、token、descriptor/capability、workspace、session 或客户端字段。
- exact selection 唯一，相同 selection 的并发不同 connectionId 只有一个 Created，loser 返回同一 Existing winner；owner、Credential revision 或 protocol version 变化形成独立 connection。
- connectionId collision 返回 Conflict；读取 persisted row 重新执行 strict validation/hash，owner tamper fail-closed。
- Debug 隐藏 actor/tenant/space、Credential ID 与 record hash；表硬上限 1024，容量耗尽不覆盖或删除旧记录。

## Processor Red / Green

- 未注册 processor 只接受 `providerId`/`connectionId`，不接受客户端 credential、owner、scope、endpoint、protocol 或 grant revision。
- connect/read 在 descriptor I/O 前后重验 composite authority；前后 grant/mapping 不一致、旧 connection grant、跨 owner、protocol drift 均 fail-closed。State connection 只是 immutable selection，不是 runtime authority。
- targeted 3/3、完整 app-server 1067/1067 通过，1 skipped；final fmt 后 processor 346 LoC、Harness 284 LoC。

## Projection Red / Green

- 预公开 Provider connection projection 已移除 CredentialRef，避免暴露内部 Grant 或制造 fake Credential；仓库无真实 RPC/客户端消费方，因此不保留兼容字段。
- adapter 显式映射 Provider/Resource capabilities，canonical projection hash 排除 observedAt；相同内容 ETag 稳定，能力集变化 ETag 变化。
- targeted 2/2、protocol 241/241、schema generation、完整 app-server 1069/1069 通过，1 skipped。
- final fmt 后 adapter 155 LoC、Harness 207 LoC，总 362 行。

## Startup Composition Red / Green

- startup runtime 默认关闭；配置关闭或从重启环境移除时不要求依赖、不恢复旧 connection/grant authority。
- 显式启用时，SQLite State 与 principal production identity reader 都是硬前置；所有 active durable mappings 在 transport accept 前按 page 100、总量 1024 的上限刷新，失败不返回 readiness token。
- runtime connect 复用 server-resolved grant processor 与 projection adapter；真实 RS256 descriptor Harness 返回 secret-free projection，Debug 不暴露内部状态。
- targeted 3/3、最终完整 app-server 1072/1072 一次通过，1 skipped、3 slow。final fmt 后 startup production 152 LoC、Harness 342 LoC。
- 没有新增 RPC、协议、CLI、配置键、依赖、migration、rollout/session resume 或 UI surface。

## Commands 与 Review

- `just test -p crewon-state provider_connection`：5/5 通过。
- `just test -p crewon-state`：183/183 通过，0 skipped。
- `just fix -p crewon-state`：通过，无 warning。
- 最终 `just fmt`：通过；按仓库规则未在 fix/fmt 后重复测试。
- production record 219 LoC、runtime 156 LoC；migration + production + sibling tests 共 697 行，低于 review Gate。
- migration additive；无依赖、Cargo/Bazel lock、app-server API、CLI/config 或 rollout/session resume 变化。`state/BUILD.bazel` 已通过 migration glob 提供 compile data，无需单独修改。
