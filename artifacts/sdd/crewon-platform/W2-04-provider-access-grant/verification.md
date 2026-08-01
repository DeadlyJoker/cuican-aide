# W2-04PAG Verification

状态：Discovery/纠偏、Stage A Secret-free State kernel、Stage B server-owned exact-scope provisioning + composite authority lifecycle Harness，以及 Stage C processor、secret-free projection、startup readiness composition 与 experimental provider/connect/read RPC/schema/TestAppServer Green；Resource API 与 product Gate 继续关闭。

## 代码证据

- Agent Platform `provider_run/auth_tokens.py` 只把 delegation credential 解析为 id/revision/owner authority；`authorization.py` 将其绑定到 digest、scope 和 run identity。
- Agent Platform `provider_run/production_resolver.py` 固化 Agent model route；`materialized_credentials.py` 按当前用户从 `UserModelApiKey`/`NewApiAccountBinding` 解密真实密钥。CrewON delegation credential 不参与该 Secret lookup。
- CrewON `crewon-secrets::CredentialStore` 的 create/rotate 都要求 `CredentialSecret`，适合真实 Vault record；当前 app-server production 没有创建 Provider credential 的调用链。
- 旧未注册 processor 要求 `ProviderConnectParams.credentialId/revision`，只有 FakeCredentialStore Harness 能先造出该值；真实客户端无法安全获得首次 selection。

## 已完成纠偏

- 删除未注册 Provider connect/read processor、projection adapter 及其 fake Credential Harness。
- 删除 `ProviderCredentialSelection` 与 client-selected `ProviderConnectParams`；没有注册或保留一个无法真实工作的 RPC。
- 保留经过验证的 durable Provider connection State kernel和 production live descriptor factory；它们不依赖客户端 owner/endpoint，也不创建 runtime authority。
- principal-session exchange 在返回可用 session 前持久化 authoritative resolve 得到的 exact Provider identity mapping；owner drift/state conflict fail-closed。
- schema 重新生成后 `crewon-app-server-protocol` 241/241 通过；完整 `crewon-app-server` 1059/1059 通过，1 skipped。两项既有 Unix signal timing test 经 nextest 自动重试后通过，未涉及本切片。

## Stage A Red / Green

- Red Harness 先引用不存在的 `ProviderAccessGrantRecord`、lookup/outcome 与 State methods；targeted build 按预期以 28 个 unresolved type/method error 失败。
- migration `0044_provider_access_grants.sql` 只保存 opaque grantId、exact principal owner、provider/source binding revision、canonical scopes JSON、status/expiry/revision/hash/timestamps；没有 Secret、proof、token、endpoint、workspace、prompt 或 Provider response。
- active owner/provider 与 active provider/sourceBinding/revision 各有 partial unique index，防止同 owner 多 active grant和 source binding 跨 owner mix-up；record/text/JSON/hash/timestamp 在数据库与 Rust 两层有界。
- record 要求 canonical `provider-grant:<UUID>`、`principal:<sha256>`、canonical source UUID、positive SQLite-safe revision、非空有序去重 scopes、finite expiry 和 active/revoked 状态一致性；canonical hash覆盖全部字段与 scope cardinality。
- Debug 只显示 grant reference、provider、scope count、status/revision/time，owner、source binding、scope values 与 record hash 均 redacted；错误不携带字段值。
- create-or-resolve 使用 `BEGIN IMMEDIATE`：同 exact authority 的并发不同 grantId 只有一个 Created，另一个返回同一 Existing；scope/source drift、source-owner mix-up 与 grantId collision 返回 Conflict。
- active lookup 同时 exact 校验 owner/provider/source id/revision 并要求 `expiresAt > now`；current owner lookup 允许 provisioner 找到已过期的 persisted active row。replacement 在单一 `BEGIN IMMEDIATE` 中先做 exact owner/provider/scope、source revision、collision 与容量校验，再 CAS revoke current 并插入新 grant；失败不丢失原 authority。显式 revoke exact replay 幂等，stale request conflict。
- persisted row 每次读取重新 parse bounded scopes JSON 并验证 canonical hash；SQL tamper fail-closed。表硬上限 1024，满载不覆盖、不删除、不复用旧 grant。
- targeted 7/7、完整 `crewon-state` 190/190、app-server principal exchange 4/4 通过；Bazel state query 包含 migration、production 与 sibling tests。
- final fmt 后 production modules 为 record 475 LoC、runtime 471 LoC，均低于 500 LoC。建议 review 分成 A1 record/migration、A2 runtime/Harness 与 B1 provisioner/composition 三个小提交。

## Stage B Red / Green

- provisioner 只消费 verified `ProviderIdentitySourceOwner`、active exact source snapshot、principal session expiry 与 server-owned fixed scopes `provider.discovery`、`providerKnowledge:search`、`providerTool:call`；不接受客户端 owner、scope、grant id/revision 或 Secret，也不使用 `CredentialStore`。
- principal-session exchange 的顺序是 bootstrap verify -> authoritative resolve -> active check -> exact mapping persist -> remote principal session issue -> grant provision。grant 冲突、容量或 State 不可用时，已签发 token 不向客户端返回；重复 exchange 依靠 exact mapping、remote issuance 与 grant resolve/replace 收敛。
- 相同 authority/expiry exact reuse；expiry 或 source revision 变化使用原子 replace；scope widening、同 source revision 回退、owner drift、source mix-up 和容量耗尽 fail-closed。并发 provision 收敛到单一 active grant。
- targeted provisioner 3/3 与 principal exchange 4/4 通过。`crewon-app-server` 全包三次尝试均完成 1062 项执行，但分别被已有 Office auto-dispatch 或 Unix signal timing case 阻断最终全绿；各失败用例隔离重跑均 1/1 通过，新增 grant/principal 用例没有失败。该非确定性问题记录为既有并发稳定性项，不扩散修改到 Office/transport。

## Stage B Lifecycle Red / Green

- Red Harness 先引用不存在的 composite authority resolver，按预期只因缺失 production module 编译失败。
- resolver 先通过既有 provider identity adapter 重验 authenticated principal、CredentialOwner、fresh mapping 与 principal source binding，再以 exact owner/provider/source id/revision 查询未过期 grant；scope 必须精确等于固定三项集合。W2-05 production Credential resolver 进一步冻结 mapping id/revision + mapped identity，并重验 connection credential revision。
- 返回值只在 app-server 内部携带 server-owned Provider identity 与 grant record，Debug 全量 redacted；客户端不能提交或读取 owner、source binding、scope、grant id/revision。
- lifecycle Harness 2/2 覆盖 exact replay、State close/reopen、无认证/logout 后请求、space context switch、principal source revision drift、grant expiry 与 mapping terminal revoke，均按预期 fail-closed。
- 增量完成后的完整 `crewon-app-server` 1064/1064 通过，1 skipped；两个 Unix signal 与一个既有 Office auto-dispatch 时序项在 nextest 第二次尝试 Green，标记 flaky。

## Stage C Processor Red / Green

- Red Harness 先引用不存在的 `ProviderConnectionProcessor`，按预期只因缺失 production module 编译失败。
- connect 的唯一客户端选择语义是 `providerId`；processor 从 authenticated principal 解析 composite authority，读取 live descriptor，I/O 后再次解析并要求前后 authority 完全一致，再以 grant id/revision 作为 server-owned immutable selection 写入 connection State。
- read 先按 connection owner fail-closed 隔离，再重验 current composite authority；旧 grant、grant rotation/revoke、mapping drift、descriptor protocol drift 或外部 I/O 中途 authority 变化都不能由 persisted connection 绕过。
- connection view 仅供 app-server 内部 projection adapter 消费，Debug 隐藏 owner、grant/credential 与 source binding；当前没有 RPC、wire Params、message processor route 或 UI 可达性。
- targeted 3/3 覆盖 exact connect replay、State reopen 后 read、cross-owner read、live protocol drift 与 descriptor I/O 中途 grant revoke。增量后的完整 `crewon-app-server` 1067/1067 通过，1 skipped，无 flaky。
- final fmt 后 production processor 346 LoC、Harness 284 LoC，总 630 行，符合单切片 800 行 Gate；projection/startup 不混入该 review slice。

## Stage C Projection Red / Green

- 审计发现预公开 `ProviderConnectionProjection.credential` 会迫使 adapter 暴露内部 grant id/revision 或伪造客户端 Credential；仓库没有 RPC 注册或消费方，因此在公开前移除该字段，`CredentialRef` 类型本身继续服务其他平台契约。
- Red Harness 先引用不存在的 projection adapter/new view constructor，按预期编译失败；Green adapter 只消费已经双检过的 internal connection view。
- Provider/Agent capability 和 ResourceKind/BindingMode/ExecutionLocation 做显式映射；Agent Platform 新增未知 capability 时 wildcard fail-closed，不静默降级。
- projection ETag 对 connection/provider/protocol/status/capability/resource capability 的 canonical JSON 做 domain-separated SHA-256；不包含 observedAt，因此内容不变的重复 read ETag 稳定，能力变化时 ETag 改变。
- serialized projection 不含 owner、tenant、space、source binding、grant/credential id、scope、endpoint 或 Secret；protocol schema/TS direct Harness 也断言没有 credential 字段。
- targeted projection 2/2、`crewon-app-server-protocol` 241/241、schema generation，以及完整 `crewon-app-server` 1069/1069 通过，1 skipped。
- final fmt 后 projection adapter 155 LoC、Harness 207 LoC，总 362 行；protocol correction 只删除未公开 DTO 字段及相应测试 fixture，低于 review Gate。

## Stage C Startup Red / Green

- Red Harness 先引用不存在的 `PreparedProviderConnectionRuntime`，按预期只因缺失 startup production module 编译失败。
- startup runtime 从真实 process environment 构造默认关闭的 Provider production factory；关闭或移除配置时立即返回 `None`，不要求 State/Principal reader，也不恢复持久化 connection/grant 为运行 authority。
- 启用时必须同时获得 SQLite State 与 `PreparedPrincipalSessionProduction` 持有的 exact Agent Platform identity source reader，并在任何 stdio/unix-socket/websocket accept 前刷新全部 active durable identity mappings。缺失依赖返回 `InvalidInput`，source/state/capacity/snapshot conflict 返回 `ConnectionRefused`，不产生 readiness token。
- runtime 只持有 State、fresh readiness token、production factory 与 clock；connect/read 复用既有 authority-double-check processor 和 secret-free projection。Debug 全量 redacted；后续 RPC 仅通过独立 request processor 注入该 runtime，UI 未接线。
- targeted startup 3/3 覆盖默认关闭、配置移除、缺失依赖、source unavailable、State reopen、重启再次刷新、真实 RS256 descriptor connect 和 secret-free projection。
- 完整 `crewon-app-server` 最终回归 1072/1072 一次通过，1 skipped、3 slow；新增 startup 用例均首次通过。
- final fmt 后 startup production 152 LoC、Harness 342 LoC，总 494 行；无新依赖、migration、协议、RPC、CLI、配置键、rollout/session resume 或上下文注入变化。

## Stage D RPC Red / Green

- `provider/connect/read` 仅接受 `providerId`/`connectionId`，由 server-derived RequestIdentity 解析 grant；客户端 authority 字段在 wire 反序列化阶段拒绝。
- 独立 request processor 穷举映射 runtime error，不回显 grant/source/owner/endpoint/scope；disabled runtime 返回稳定 fail-closed 错误，不复用旧 Open API credential。
- 真实 runtime Harness、TestAppServer、experimental/stable schema generation 全部通过；targeted Provider 15/15、protocol 242/242、app-server 1077/1077 Green，1 skipped、1 slow、1 个既有 Office timing case retry Green。

## 未验证

- Resource list/read、durable Resource Binding、projection notification 与 W2-06 UI。

## Gate

上述未验证项完成前，W2-04 product Gate、W2-05、W2-06 与 W2-08 均保持关闭。下一最小可评审切片是 resource list/read live catalog adapter；durable Resource Binding 继续保持独立切片。
