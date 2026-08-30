# W2-05 Verification

状态：CrewON 侧 Provider v3 contract/client/executor、Agent Platform Tool/Knowledge server、显式 registration、dynamic discovery、Provider Artifact exact read 与 digest-verified local import 均已 Green。Provider-only W2-05 v1 Gate 已 Green；本地 MCP materialization 因缺少真实 package/download capability 而从当前 Gate 移出，并在 Router、Credential resolver、State claim 三层 fail-closed。W2-07 独立组件 Gate 也已 Green，W2-08 已解锁负责中心 supervisor/scheduler/outbox 接线，并须与旧浏览器 PIM 删除原子完成。

## Discovery evidence

- `pimDynamicTools.ts` 在浏览器注册 `pim` namespace，直接 POST 旧 `/api/v1/mcp/tools/{id}/call` 与 `/api/v1/knowledge/search`。
- Agent Platform 旧 `crewon_catalog.py` 确有 MCP/Knowledge proxy endpoint，但它依赖 downloaded resource 和旧 user authorization，不提供 Provider v3 exact revision/delegation/idempotency contract。
- Agent Platform production descriptor 在 `PROVIDER_DYNAMIC_ENABLED=false` 时保持 Agent-only；只有完整动态应用、Artifact、permission、discovery 和 executor 同时装配且开关为 true 时，才精确声明 `remoteTool/remoteKnowledge` 及四个 Tool/Knowledge binding capability。
- Rust `crewon-provider-agent-platform` 已完成 additive strict Tool/Knowledge v3 contract，但只有对端 descriptor 精确声明能力时才启用；现有 Agent-only descriptor 继续通过原有 Harness，未知/半声明能力 fail-closed。
- W2-04 `resource/bind` 当前仅允许 RemoteReference/ProviderManaged -> Provider；LocalSnapshot/LocalFork 在没有 materializer 时返回 Incompatible。
- `ProviderResourceBindingRecord` 固定 exact resource/binding/location/hash，但没有 local MCP server/tool locator；不能从 Resource ID 或 UI 参数猜测。
- `McpConnectionManager::call_tool` 已提供既有配置型本地 MCP 的唯一调用入口；`list_all_tools` 只返回当前/缓存 ToolInfo，manager/config 没有 immutable executable/package revision、ETag/source digest 或 Credential revision provenance。因此本期不把本地 MCP 伪装成 Provider Binding，也不让它阻塞纯云 Provider Router。
- W1-08 Action Digest 和 move-only ExecutionAuthorization 足以绑定真实 arguments/revision/location/Credential；W1-09 Audit 可以记录 external-action metadata。Discovery 时缺失的 production execution journal 已在 P3b-P3d 补齐。

## Current Gate

| Gate | 状态 | 原因 |
| --- | --- | --- |
| Discovery/SDD | Green | 真实入口、矩阵、威胁和前置已冻结 |
| Route registration kernel | Green | 唯一矩阵、reserved namespace、冲突、上限、arguments bound、binding drift 已通过 Harness |
| Policy/journal admission kernel | Green | side effect、Policy/Approval、live Credential、owner/workspace 与 exact call claim 已通过 Harness |
| Adapter dispatch/completion kernel | Green | consume-only Provider port、timeout/unknown/cancel、completion 和 bounded result已通过 Harness；无 Local/fallback 分支 |
| CrewON Provider Tool/Knowledge contract/client | Green | strict descriptor/manifest、exact RS256 delegation、single execute endpoint、closed outcomes、bounded result/digest 与 canonical/mock HTTP Harness 已完成 |
| Provider Credential resolver | Green | 使用完整 server-derived RequestIdentity 重验 principal、fresh mapping、固定 scope、active Grant、connection/revision，并冻结 identity mapping revision |
| Provider executor kernel | Green | exact claim -> pinned client/delegation，target/operation/credential drift 在网络前拒绝，无 retry/fallback |
| Agent Platform Tool/Knowledge server | Green | 独立默认关闭的 production composition 提供显式 registration、bounded list/read、exact manifest、one-shot execute、permission、idempotency/Audit 与真实 MCP/Knowledge adapter |
| Provider Artifact importer | Green | Provider raw Artifact read 绑定 callId + actionDigest + actor/tenant/space，Rust 重验 media/digest/metadata/UTF-8 后幂等写入本地 durable Artifact/Audit |
| Local MCP materialization | Deferred / 非 v1 Gate | 当前无 package/download capability；Router、Credential resolver、State claim 对 LocalNode fail-closed，既有静态 MCP 路径不变 |
| Durable idempotency/Audit | Green | 0046、State claim/complete/recovery、atomic ExternalAction Audit 与 app-server State journal adapter 已通过 restart/concurrency Harness |
| W2-08 production composition | Ready for SDD/composition | W2-05/W2-07 独立组件已就绪；W2-08 自身负责受监督 event pump、scheduler/outbox 和 UI PIM 原子切换，真实部署 key/model smoke 在 W3-01 生产流量切换前补齐 |

## No-claim boundary

当前没有部署或启用 `PROVIDER_DYNAMIC_ENABLED`，也没有修改中心分发或删除旧 UI 路径；Hermetic server/client Green 不等于生产环境已经切流。W2-05 Provider-only v1 代码前置已闭环；W2-08 仍因 W2-07 的真实 production composition 前置而保持关闭，旧 API 也不得作为 fallback。

## P1 evidence

- 新增独立 `platform_control/dynamic_tool_router/registration.rs`；没有修改 `message_processor.rs`、Core 或 UI。
- Provider 只允许 McpTool/KnowledgeBase + RemoteReference/ProviderManaged + Provider；LocalSnapshot/LocalFork + LocalNode 明确 Incompatible。
- namespace 固定从 canonical binding UUID 生成 `crewon_binding_<32 hex>`，operation name 固定 `call/search`；同 namespace/name 冲突整批拒绝。
- registry 最多 64 项，单次 arguments JSON 最多 64 KiB；未知工具、invalid identifier、跨位置 target 和 binding 全对象 drift 均 fail-closed。
- `just test -p crewon-app-server dynamic_tool_router`：6/6 Green。
- `just test -p crewon-app-server`：1094/1094 Green，1 skipped、1 slow；新增路由用例无 retry 或 flaky。
- production registration 模块 343 LoC；本阶段代码、测试和 SDD 合计低于 800 LoC，没有新增依赖、RPC、配置或 rollout 变更。
- `just fix -p crewon-app-server`：Green；只报告 5 条既有 Office/Agent Platform lint warning，本切片无新增 warning。
- 最终 `just fmt`：Green；按仓库规则未在 fix/fmt 后重跑测试。完整 workspace `just test` 未执行，仍需用户明确授权。

## P2a evidence

- `DynamicToolPolicyContext` 不接受 sideEffect；MCP side effect 在 server registration 时冻结，Knowledge Search 非 ReadOnly 直接 Incompatible。
- Admission 每次重读完整 binding，校验 actor/tenant/space/workspace/status/revision/hash，再通过 server-owned port 解析 live Credential 状态和 revision。
- ReadOnly 产生立即 authorization；ExternalWrite 在没有 Approval 时不 claim。exact Approval 可 claim，arguments 变化返回 ActionDigestMismatch。
- journal claim metadata 关联 actor/workspace/provider/resource/binding revision/access decision/action digest，但不含 raw arguments/result；相同 callId+digest 返回 Duplicate，不同 digest 返回 Conflict。
- AuthorizedCall 同时持有 move-only claim、唯一 target、operation 和 bounded arguments，Debug 固定 redacted；P2a 当时不提供 dispatch，P2b 现在只允许 dispatcher 消费该 capability。
- 最终结构调整后 `just test -p crewon-app-server dynamic_tool_`：11/11 Green，其中 9 个 W2-05 unit Harness、2 个既有 dynamic-tool round-trip。
- 大枚举堆分配 lint 调整前 `just test -p crewon-app-server`：1097/1097 Green，1 skipped、1 slow；2 个既有 Unix signal/Office timing case retry Green，新增用例无 flaky。该调整后按仓库规则只重跑 targeted，再执行 final fix/fmt。
- P2a production modules：admission 304 LoC、ports 118 LoC，均低于 500 LoC；无新 RPC、配置、依赖、rollout 或 Context 注入。
- 最终 `just fix -p crewon-app-server`：Green；只剩 5 条既有 Office/Agent Platform warning，本切片新增 large-enum/duplicated-attribute warning 已消除。最终 `just fmt`：Green，之后未重跑测试。
- W2-08 handoff 已冻结：生产前置全部 Green 后，Dynamic Tool server composition 与旧浏览器 PIM executor 删除必须原子完成；通用 client dynamic tool 协议保留，并用调用点扫描证明不存在旧 API fallback。

## P2b evidence

- Credential resolver 现在返回由服务端构造的 snapshot；同一 snapshot 生成 Policy CredentialBinding、进入 claim 的 credentialId/revision，并随 move-only AuthorizedCall 进入唯一 executor。Provider target 收到 `None` Credential 时在 claim 前返回 CredentialRequired。
- W1-08 amendment 让 consumed Approval 产生的 ExecutionAuthorization 携带 exact approvalId；即时 read-only authorization 保持 none。claim 冻结 actor/tenant/space/session/trace、thread/turn、Workspace scope、accessDecisionId、approvalId、binding/resource/Credential revision。
- Dispatcher 通过唯一 native RPITIT Provider port 执行；代码中不存在 Local 或另一位置的 retry/fallback 分支。Failed、AdapterUnavailable、InvalidResponse 和 timeout 使用 closed enum；hard timeout 一律 Unknown。
- 取消正在等待的 adapter future 后，durable claim 保持 claimed 且没有伪 terminal completion，供后续 State recovery/reconcile；router 内不 sleep、不自动重放写操作。
- completion 消费 move-only claim；production port contract 要求 terminal journal transition 与 metadata-only ExternalAction Audit 原子提交。FakeJournal 仅保留为 kernel Harness，State-backed implementation 已在 P3b-P3d Green。
- inline result 最多 16 项、总 JSON 32 KiB、单项 16 KiB；远程图片 URL 被拒绝，raster data URL 同时验证 base64 与 PNG/JPEG/WebP/GIF signature。更大正文/图片必须先成为 exact ArtifactRef；journal 只保存 item count/bytes/digest 或 ArtifactRef。
- completion 写入失败或冲突统一返回 UnknownOutcome；已经发生的 side effect 不重试，也不 fallback。Debug/Harness 扫描不包含 raw arguments/result 或 Credential。
- `just test -p crewon-policy`：10/10 Green；新增断言证明 immediate authorization 无 approvalId、consumed authorization 保留 exact approvalId。
- 最终结构下 `just test -p crewon-app-server dynamic_tool_`：18/18 Green，其中 16 个 W2-05 kernel Harness、2 个既有 dynamic-tool round-trip。
- `just test -p crewon-app-server`：1104/1104 Green，1 skipped、1 slow；3 个既有 Unix signal/in-process timing case 在 retry 2 Green，新增 Dynamic Tool 用例无 flaky。
- production modules：registration 368 LoC、admission 384 LoC、ports 326 LoC、dispatch 464 LoC，均低于 500 LoC；UI/Core/message_processor/RPC/config/schema/rollout 未修改，也没有新依赖。
- 最终 `just fix -p crewon-policy` 与 `just fix -p crewon-app-server` Green；app-server 只剩 5 条既有 Office/Agent Platform warning。最终 `just fmt` Green；按仓库规则之后未重跑测试。
- 完整 Rust workspace `just test` 未运行，仍需用户明确授权；本切片没有修改 common/core/protocol。

## P3a Audit Unknown evidence

- W1-09 `AuditOutcome` 已增加 `Unknown { errorCode }`；Dynamic Tool timeout/transport ambiguity/completion durability failure 可保留真实语义，不再伪记为 Failed。
- State strict Audit JSON schema 只接受 `type=unknown` 与 bounded `errorCode` 两个字段；附加 raw provider `message` 直接 InconsistentFields。
- `just test -p crewon-artifact`：10/10 Green；`just test -p crewon-state`：199/199 Green。
- 最终 `just fix -p crewon-artifact`、`just fix -p crewon-state` 与 `just fmt` Green；之后未重跑测试。
- P3a 本身没有 migration；当时保持 Red 的 Durable idempotency Gate 已由后续 P3b-P3d 的 0046、runtime 和 State adapter 转为 Green。

## P3b-P3d State journal/Audit evidence

- 新增 `0046_dynamic_tool_execution_journal`，状态只允许 claimed/succeeded/failed/unknown；terminal code、inline metadata/ArtifactRef、Audit FK 和时间组合由数据库 CHECK 约束，digest/hash 同时校验 canonical `sha256:` lowercase hex。
- claim record 冻结 workspace binding、connection、protocol/resource kind、execution location、trace span、exact Credential，以及 Provider identity binding id/revision + subject/tenant/space；Debug 对 authority/workspace/resource/credential/hash 全部脱敏。生产模块保持拆分且均低于 500 LoC。
- State claim 在同一写事务中重验完整 hash-bound binding、connection、Provider grant 与 fresh exact identity mapping。Policy retry 的新 accessDecisionId 不会重放同一 action；原 claim 的完整 authority snapshot 仍用于 terminal completion。
- terminal transition 与 `platform_audit_events` insert 原子提交；Audit 必须逐字段匹配 actor/workspace/Conversation/trace/resource/approval/outcome/ArtifactRef，缺失 Artifact、identity collision、metadata/hash tamper 或并发第二终态均 fail-closed 且不留下半写。
- cancellation/restart 只留下 claimed；recovery API 使用 callId cursor、最多 100 条，不 sleep、不重试、不自动重放外部动作。Provider binding 有真实 State Harness，LocalNode claim 在 record validation 与 State authority recheck 中拒绝。
- app-server `StateDynamicToolExecutionJournal` 将 move-only port 映射到 State record/domain Audit；event/idempotency/span ID 由服务端确定，completion clock 回退会拒绝且保持 claimed。journal/audit 模块分别 292/226 LoC。
- `just test -p crewon-state`：208/208 Green。
- `just test -p crewon-app-server dynamic_tool_`：20/20 Green，其中 State adapter 2 个真实 SQLite Harness、既有 round-trip 2 个。
- `just test -p crewon-app-server`：1106/1106 Green，1 skipped、2 slow；1 个既有 Office startup timing case retry 2 Green，新增 Dynamic Tool 用例无 flaky。
- `just fix -p crewon-state`：Green；`just fix -p crewon-app-server`：Green，只保留 5 条既有 Office/Agent Platform warning；最终 `just fmt`：Green。按仓库规则，fix/fmt 后未重跑测试。
- 本切片没有修改 RPC、app-server protocol、配置、Core、UI、依赖或 rollout；没有中心 composition，也没有启用尚未满足 Gate 的 Provider/Local executor。

## G1a-G1b CrewON Provider amendment evidence

- `crewon-provider-agent-platform` 支持 `remoteTool/remoteKnowledge` 与 `McpTool/KnowledgeBase`，只接受 `RemoteReference/ProviderManaged + Provider`；baseline Agent-only fixture 保持兼容。
- `dynamicResources:read` 返回 exact revision/content digest、operation、closed side effect、bounded description/schema 与 schema digest；Knowledge 只允许 `search + readOnly`。
- `dynamicActions:execute` 只接受 exact resource/callId/actionDigest/Credential id+revision；RS256 delegation audience/type/purpose/scope 固定，Tool/Knowledge 分别使用 `providerTool:call` / `providerKnowledge:search`。
- response 重验 callId/actionDigest，result digest 从实际 closed wire representation 重算；inline text 上限受控，图片/大结果只能返回 exact Provider Artifact reference。`ProviderDynamicExecutionSuccess` 的 public Harness constructor 也从真实 wire representation 自行派生 digest，不能构造 digest 与结果不一致的成功对象。
- Provider executor 从 claim 还原 exact Provider identity/resource/operation/credential，target drift 在发网前拒绝；只调用 strict client。Artifact 结果必须经 authenticated raw read、digest/header/UTF-8 校验和本地 durable import 成功后，才返回本地 ArtifactRef。
- Provider Access Grant 由服务端固定生成并严格要求排序集合 `provider.discovery`、`providerKnowledge:search`、`providerTool:call`；客户端不能提交 scope。每次外部执行仍只签发一个 resource/operation 的短期 delegation，不把宽 Grant 直接发送给 Provider。
- production Credential resolver 不再只消费 `RequestIdentityRef`，而是重验完整 authenticated `RequestIdentity`、CredentialOwner、fresh mapping/source binding、active exact Grant、connection owner/protocol/credential revision；claim 冻结 mapping id/revision 与 mapped subject/tenant/space，mapping drift 在 State claim 内失败。
- targeted evidence：Provider dynamic execution 5/5、Provider executor 2/2、Credential resolver 2/2、Access Grant 5/5、principal-session exchange 4/4、Provider connection 15/15 Green。

## G1c cross-service Green evidence

- Agent Platform 新增 `mcpTool/knowledgeBase` immutable revision records、显式 permission-gated registrar、bounded cursor discovery、exact execution manifest、独立 RS256 dynamic delegation、callId/JTI durable idempotency、claimed/terminal Audit 和真实 MCP/Knowledge executor；进程在 claim 后退出会保留 unknown/reconcile 语义，不自动重放副作用。
- `PROVIDER_DYNAMIC_ENABLED` 独立且默认 false；Provider Run 关闭时不能单独打开 dynamic。动态开关关闭时 descriptor 不声明能力，打开时完整 composition 才声明能力，避免半装配。
- 动态大结果进入 Provider-owned 64 KiB Artifact；owner 同时绑定 callId 与 actionDigest。`dynamicArtifacts:read` 返回 raw bytes + exact metadata headers，不返回 URL。CrewON 客户端重验 ID/revision/digest/sensitivity/media/UTF-8，本地 importer 再以 provider/call/action/artifact digest 派生 idempotency 并原子提交 Artifact/Audit。
- MCP Tool source digest 固定语义配置但不保存 Secret；Knowledge exact revision digest 有 document/chunk/text hard cap，search 前后重验 source digest。MCP/Knowledge permission 分别固定为 server execute / knowledge read；registration 固定 manage。
- Agent Platform `uv run pytest -q tests/provider_run`：238/238 Green；`ruff check app/modules/provider_run tests/provider_run` 与 `mypy app/modules/provider_run` Green。CrewON `just test -p crewon-provider-agent-platform`：61/61；`just test -p crewon-app-server`：1112/1112，1 skipped、5 slow。
- `scripts/verify-agent-platform-provider-contract.sh` 同时验证 Provider Run、Discovery、Dynamic Execution/Artifact Read 三份 canonical contract byte-for-byte，并校验 provenance SHA；三项 Green。
- 这些证据不等于生产部署或切流；资源只在显式授权 registration 后可发现，旧 proxy/user token/latest/browser PIM 仍禁止 fallback。

## G2 Local materialization scope correction evidence

- `McpConnectionManager::list_all_tools` 聚合 live/cached ToolInfo；`call_tool` 按当前 `(server, tool)` 路由。两者都没有能够绑定 executable/config/package 的 immutable source revision 或 digest。
- 当前 `McpServerMetadata` 只有 origin、parallel-call 与 memory-pollution 等运行元数据；OAuth/config 也没有暴露给 Resource Binding 的 stable Credential revision provenance。
- 同名 server/tool 在配置、二进制或远端实现变化后仍可能保持相同 locator 和 schema。把该 locator 直接写入 `localSnapshot/localFork` 会绕过 W2-04 exact-revision 语义，因此已删除未受真实 materializer 支撑的 `LocalMcpTarget`、Local executor port 和 Local dispatch 分支。
- 当前 Provider descriptor 只声明 Provider execution，且没有本地 package/download API；把 Local materialization继续作为 W2-05/W2-08 前置会形成不可达设计。v1 因此只支持 Provider Tool/Knowledge，Local registration、Credential resolution 与 durable claim 全部 fail-closed。
- 未来只有真实产品需求出现时才创建独立 Local materialization SDD；最低条件仍是 content-addressed/built-in 或不可变远端 revision、schema+source 原子关联、Credential/permission revision、restart revalidation 与 drift/revoke Harness。满足前禁止恢复 Local executor 或把 schema digest 当作实现 digest。

## V5 final verification

- `just test -p crewon-provider-agent-platform`：59/59 Green；包含 baseline Agent contract、dynamic descriptor/manifest、RS256 exact delegation、execute client、wire digest 与 no-retry Harness。
- `just test -p crewon-state`：208/208 Green；包含 Provider identity revision claim revalidation、credential/connection/binding drift、atomic completion/Audit 与 restart recovery。
- `just test -p crewon-app-server`：1110/1110 Green，1 skipped、6 slow；新增 Provider executor/credential resolver 和 scope amendment 未出现 retry 或失败。
- `just fix -p crewon-state`、`just fix -p crewon-provider-agent-platform`、`just fix -p crewon-app-server` Green。app-server 仍报告 5 条既有 Office/Agent Platform lint warning，本 amendment 无新增 warning。
- 最终 `just fmt` Green；按仓库规则 fix/fmt 后未重跑测试。完整 Rust workspace `just test` 未执行，因为该命令仍需用户明确授权。
- 未修改 Agent Platform sibling repo、中心 message processor/Core/UI/RPC/schema/config；没有 composition、旧 UI 删除或假成功路径。

## V6 G1c/A1a final verification

- Agent Platform Provider Run full suite：238 passed；动态 contract/auth/application/registration/permission/executor/artifact/discovery/HTTP/production gate 与 PostgreSQL schema 编译均覆盖。
- CrewON Provider full suite：61 passed；新增 Artifact read canonical command、raw response exact metadata、非 UTF-8 拒绝和无 semantic retry。
- CrewON app-server full suite：1112 passed，1 skipped、5 slow；新增 Provider Artifact read -> importer -> local ArtifactRef 成功链和 State-backed importer 幂等 Harness。
- 跨仓库合同：Run `e8b07b…63046a`、Discovery `f83f8199…c1b6a6`、Dynamic `c7d5b0e2…9fe6b` 均 byte-for-byte 与 provenance SHA 一致。
- `just fix -p crewon-provider-agent-platform`、`just fix -p crewon-app-server` 与最终 `just fmt` Green；app-server 仅保留 5 条既有 lint warning，按仓库规则之后未重跑测试。
- production 开关仍默认关闭；本轮未接中心 Dynamic Tool authority、未删除旧 UI、未实现或伪造 Local MCP materialization。

## V7 Provider-only scope correction verification

- `just test -p crewon-state dynamic_tool_execution`：9/9 Green；新增真实 StateRuntime Harness 证明 LocalNode claim 在事务前 fail-closed。
- `just test -p crewon-app-server dynamic_tool`：44/44 Green；覆盖 Provider registration/admission/dispatch、Credential/revoke/drift、State journal/Audit、Artifact import、timeout/unknown/cancel、bounded result，以及 Local binding Incompatible。
- 删除 `LocalMcpTarget`、`LocalDynamicToolExecutionRequest`、`LocalDynamicToolExecutor` 和 dispatcher Local generic/branch；没有新增替代 locator、fake materializer 或 fallback。
- `StateDynamicToolCredentialResolver` 对非 Provider location 返回 Unauthorized；State execution record 只接受完整 Provider Credential + identity mapping authority，storage defense-in-depth 对 LocalNode 返回 false。
- 本次收敛不改变 Resource Binding 的未来枚举兼容面，不修改外部 RPC、app-server protocol、Core rollout、UI 或已有静态 MCP 执行路径。
