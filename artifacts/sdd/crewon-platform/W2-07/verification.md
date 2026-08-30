# W2-07 Verification

状态：独立组件 Gate Green，尚未生产接线。CloudExecutionSpec resolver、Attempt 级 Provider Run Journal、Cancelled worker fact、start/event/cancel/reconcile、跨服务 Credential revision、secret-free durable authority、task-scoped production client factory 与 bounded restart recovery query 均已通过 Harness。Provider live/cancel/crash smoke 与 authenticated workspace process-restart recovery 已完成。W2-08 已解锁负责受监督 event pump 与 scheduler/outbox 中心 composition；真实部署 key provisioning 和真实云模型仍是生产流量切换前的 release evidence。

## Discovery 证据

- 原 `WorkerDispatch` 不包含 prompt/context/Credential 或 immutable execution spec ref。
- `ProviderRunStartRequest` 强制 exact resource/task/Credential、request digest、bounded prompt/context refs。
- 原 `TaskContractSnapshot` 无法在重启后证明重建的是同一 Provider start input。
- `WorkerExecutor::start` 返回的 `ExecutorRunRef` 没有 durable providerRunId/cursor/revision journal 消费者。
- 原 `WorkerOutcome` 无法无歧义映射 Provider `cancelled`；P4 已补齐并验证。

## P1 实现

- 新增 `ExecutionSpecId`、non-zero `ExecutionSpecRevision`、canonical `ExecutionSpecDigest` 和 metadata-only `ExecutionSpecRef`；不包含 prompt、context、CredentialId 或 Secret。
- `TaskContractSpec`、`TaskContractSnapshot` 和 `WorkerDispatch` 必须携带 exact ExecutionSpecRef。
- Task Contract schema 从未接线的 v1 提升并限定为 v2；旧/未知 schema fail-closed。
- `TaskContract::new` 对 resource bindings 按 bindingId canonicalize，并对 Task/Authority/Strategy/Workspace/schema/execution spec/bindings/createdAt 计算 SHA-256 contract hash。
- snapshot restore 重建 Contract 并比较 hash；把 execution spec 换成另一个格式合法引用也返回 `ContractHashMismatch`。
- canonical fixture hash：`sha256:e9a8a1375b6b4bf1020a6e9d4c0000560390671c164878b5cb304e0047322ae8`。

## P2/P3 实现

- `crewon-state` 新增 migration 0039：immutable `cloud_execution_specs`、ordered context Artifact refs、`provider_run_journal` 和 immutable event receipts，继续复用唯一 `state_5.sqlite`。
- CloudExecutionSpec canonical digest绑定 Task、Workspace、binding、exact Provider/resource revision、CredentialId/revision、prompt/context exact Artifact refs 与 createdAt；context 最多 32 项且不能与 prompt/彼此重复。
- Provider Run Journal 以 Task/Attempt 为唯一执行身份，并保留首次 WorkerRun 作为 admission audit；绑定 ExecutionSpec digest、Provider/resource/Credential revision、providerRunId/attemptId、start command/idempotency/request digest；mutable cursor/status/revision 使用单调 CAS，immutable `recordHash` 不被进度更新改写。
- 相同 Attempt 重放只接受等值 digest/hash；Worker reclaim 复用同一 Provider Run，不调用 Provider 第二次。providerRunId 跨 Attempt 复用、Credential drift、sequence/cursor 冲突和不同 mapping 全部返回 conflict/unknown，不覆盖已有事实。
- Artifact 增加完整 v1 execution projection restore；PolicyActor、Trace、Resource、Approval、Workspace、Execution、Retention 与 payload ref 均通过原领域构造/反序列化校验，不在 app-server 复制 schema。
- State 增加 metadata-only Artifact read；resolver 对最多 32 个 Context 不加载正文，prompt 先读取 metadata 并执行 64 KiB/MIME/availability/expiry校验后才读取单个正文。
- app-server resolver 验证 Task `ExecutionSpecRef`、唯一 ProviderManaged/Provider/Agent binding、exact resource、server-supplied Credential owner、Credential status/revision、Artifact workspace/Task correlation/digest；Resolved Debug 固定隐藏 prompt，结果不含 Credential Secret 或 Context body。
- `ProviderRunAuthorizationBinding` 加入 non-zero expected Credential revision，authorizer 每次 Run 操作均能接收 exact revision。
- Agent Platform `crewon-delegation+jwt` 的 Credential claim 强制包含 positive revision；缺失、零值、未知字段或错误 owner 均在构造 server-owned context 前 fail-closed。
- revision 进入 authorization digest、start request fingerprint、ProviderRun、ProviderRunDelegation 和 existing-run ownership；ID/revision drift 返回与 unknown Run 相同的 `notFound`，不会写 decision/delegation 或消费 JTI。
- 双方 canonical Provider Contract v3 required `credential.revision` 已同步；v1/v2 历史 fixture 保持不变。P2a RS256 issuer 已按 exact operation 签发 service/delegation/discovery token，并由 Agent Platform 真实 verifier 接受；P2b durable mapping、exact owner、source authority/freshness 与 durable workspace adapter 均已通过 Harness。默认关闭的 production endpoint/key-file factory 已能按 State 验证后的 task identity 创建短期 Provider client；CrewON 不保存 Agent Platform 模型 Secret。

## P4/CloudWorker 实现

- `WorkerOutcome::Cancelled` 将当前 Attempt 置为 Cancelled，并把非终态 Task 推进到 `Suspended(RetryDecision)`；retry/fail/user cancel 继续由 Authority 决定。
- Authority 已终结 Task 后，迟到 Provider cancelled 不回退 Task；Provider journal 仍记录、去重并推进 cursor。
- Authority cancel 后可从终态 Aggregate 重建精确 Worker cancellation evidence，支持 durable outbox 与 app-server 重启重放，不依赖已过期 lease。
- 新增未接线 `CloudWorkerExecutor`：start 先重读 SQLite 当前 Task 并深比较 dispatch/lease，再解析 exact Cloud Agent binding、ExecutionSpec、Credential 与 Artifact。
- start 在解析 Secret/prompt 前先读取 Attempt journal；存在时直接返回同一 run。首次调用 Provider 后使用 compare-or-insert，冲突一律转为 `OutcomeUnknown`。
- event pump 先提交 Task Inbox/Event/Snapshot/Outbox，再 CAS 推进 provider cursor；cursor 写失败后重放仅补 cursor，不重复 Task transition/outbox。
- cancel 读取 Provider 当前 revision 并发送 exact run/revision；reconcile 只读取并校验 same run，不创建 Attempt 或重试。
- approval/tool-result 事件维持 Unsupported，不模拟尚未开放的 capability。
- `resolve_provider_run_authority` 在每次 start/read/events/cancel/reconcile 前校验 active resource binding、connection、exact grant ID/revision/scopes、grant expiry、fresh identity mapping 与 source binding/revision，杜绝固定进程 owner 或跨 Workspace 身份复用。
- `ProviderRunClientFactory` 使用本次验证得到的 `ProviderAuthorizationIdentity` 创建 task-scoped client；生产实现复用 endpoint-pinned RS256 factory，测试实现保持窄 fake port。
- State 的 recovery query 仅返回 starting/running/suspended/reconciling journal，使用稳定 key cursor，limit 强制 1..100；terminal row 不返回，读取不触发任何 Provider/Task 副作用。

## Harness 证据

- Red：`just test -p crewon-task-runtime execution_spec` 在类型/field/error variant 尚不存在时编译失败，证明 Harness 先于实现。
- Green：`just test -p crewon-task-runtime`：32 passed，0 skipped。
- schema v2 收紧后再次运行 `task_state_store_adapter`：3 passed；`wave1_composition_gate`：1 passed。
- `task-runtime/scripts/check-dependency-boundary.sh`：通过；运行依赖仅 resource-federation、serde、serde_json、sha2，无 core/app-server/state/sqlx/reqwest/UI。
- `just bazel-lock-update` 与 `just bazel-lock-check`：通过。
- 生产模块均低于 500 LoC；Task Runtime 新实现集中于独立 `execution_spec.rs` 与既有 Contract/Snapshot/Worker port。
- Red：`just test -p crewon-state provider_execution` 在 records/runtime 模块和类型不存在时编译失败；`just test -p crewon-artifact manifest_execution_projection` 在 execution projection 不存在时编译失败；`just test -p crewon-app-server cloud_execution_resolver` 在 resolver port 不存在时编译失败；Provider authorization revision Harness 先以构造参数/访问器缺失失败。
- Green：`just test -p crewon-provider-agent-platform` 31 passed；`just test -p crewon-policy` 10 passed；`just test -p crewon-artifact` 9 passed；`just test -p crewon-state` 166 passed。
- Resolver targeted Harness：4 passed；CloudWorker targeted Harness：9 passed，覆盖 start/journal replay、Worker reclaim、冲突/陈旧 dispatch、commit-before-cursor、cursor failure replay、Authority terminal race、cancel current-revision 和 reconcile same-run。
- Provider authority targeted Harness：2 passed，覆盖 exact success、grant/source/resource drift 与 expiry fail-closed；CloudWorker Harness 已改为逐次 authority 重验和 task-scoped client。
- Provider execution targeted Harness：5 passed，新增 bounded restart recovery page、cursor、invalid limit 与 terminal exclusion。
- 最终 `just test -p crewon-app-server`：1028/1028 passed，1 skipped；其中既有 `office_startup_recovers_auto_dispatch_for_terminal_run_with_pending_delegation` 首次波动，nextest 自动重试后通过（flaky 2/2）。
- 跨服务 revision Red：Agent Platform factory 因旧 Authority 不接受 `credential_revision` 在 collection 阶段失败；Rust canonical v3 因未知 `revision` 拒绝，删除 revision 的负例被旧模型错误接受。
- 跨服务 revision Green：Agent Platform `tests/provider_run + tests/test_provider_contract.py` 212 passed；`crewon-app-server-protocol` 237 passed；`crewon-provider-agent-platform` 31 passed。
- Agent Platform scoped Ruff check/format 通过，mypy 45 source files 无错误；Rust `just fix -p crewon-app-server-protocol` 与 `just fix -p crewon-provider-agent-platform` 通过。
- Resolver Harness 覆盖精确成功路径、Secret/Context body/Prompt Debug 扫描、Credential rotation drift、多个 Cloud Agent、跨 Workspace Context 和错误 Task correlation。
- State Harness 覆盖 create-close-reopen、Attempt 级幂等重放、Worker reclaim 复用、providerRunId 跨 Attempt 冲突、依赖缺失回滚、cursor CAS 失败不留半状态、event duplicate，以及伪造小 `byteLen` + 大 BLOB 时不返回正文。
- `just bazel-lock-update` 与 `just bazel-lock-check` 通过；新增生产依赖仅把 Artifact 已使用的 `serde_json` 从 dev dependency 提升为 runtime dependency。
- 新增生产模块均低于 500 LoC：provider execution records 491、CloudWorker event pump 408、resolver 386、journal storage 287、CloudWorker start 277、CloudWorker facade 272、control 190、journal port 67。

## Breaking-change 审核

- TaskContractSpec/Snapshot 是内部 Rust surface，结构从未生产接线的 v1 变为 v2；仓库扫描没有非测试 TaskContract 创建调用点。
- app-server ClientRequest、CLI/config、Core rollout/session 均未改变；没有新增/修改 v1/v2 RPC。
- 旧 shape snapshot 会 fail-closed，而不是以缺省 ExecutionSpec 继续运行。由于 production Task consumer 尚未切换，这一收紧发生在正确的 cutover 前窗口。
- migration 0039 只新增内部 State 表，不改变已有表和外部 API；Artifact metadata read 与 resolver 均为未接线的 crate-private/internal API。
- `ProviderRunAuthorizationBinding::new` 是未生产接线的内部 Rust surface；revision 不进入 Provider command JSON，只进入敏感 delegation header 的签发请求。
- canonical Provider Contract v3 的 Credential authorization 新增 required positive revision，属于 pre-production breaking amendment；旧 v3 token/fixture 会 fail-closed。当前没有 production CloudWorker consumer，因此选择在 cutover 前修正而不保留 insecure optional/default 兼容。
- 新增 CloudWorker 模块保持 crate-private 且未注册，没有改变 app-server ClientRequest、v1/v2 RPC、CLI/config、Core rollout/session 或现有生产调度行为。

## 仍未验证 / 后续 Gate

- 隔离 Agent Platform Provider descriptor/run/artifact、运行中 cancel 与 Provider worker crash/restart/unknownOutcome 已通过；生产凭证轮换、真实云模型与生产配置仍未验证。
- W2-08 尚未把 CloudWorker、bounded recovery query、Task scheduler/outbox 和进程 shutdown 组合为唯一受监督生命周期；在该 Gate 前 CloudWorker 保持未注册。
- 真实部署 key provisioning 与真实云模型仍未验证；这不阻塞默认关闭的 hermetic composition，但阻止 W3-01 生产流量切换。
- approval/tool-result capability 尚未开放；当前明确 Unsupported。

## 结论

内部 W2-07 已关闭“重启后无法证明执行输入等值”“Worker reclaim 重复创建 Provider Run”“providerRunId/cursor 只存在内存”“Task commit 与 cursor 非原子导致重复 transition”“批量 Context 正文放大”“Provider cancelled 越权裁决 Task”“Credential revision 未进入跨服务授权事实”“固定进程身份跨用户复用”“跨重启 owner/workspace mapping 无唯一性或撤销事实”“connection/grant/source/resource drift 后仍调用 Provider”等缺口。组件足以指导并进入 W2-08 默认关闭的 production composition，但不等于已经上线：W2-08 Wave Gate、部署 key provisioning 与真实云模型 release evidence 完成前，CloudWorker 保持未注册，W3-01 不得切生产流量。
