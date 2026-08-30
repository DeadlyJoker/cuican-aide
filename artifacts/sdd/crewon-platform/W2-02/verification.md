# W2-02 Verification

状态：W2-02A Lifecycle Kernel、W2-02B production Run composition 与 W2-02C discovery surface 均已完成并通过 hermetic Harness。Provider v3 已具备分离的 Run/discovery authority、descriptor/capability、exact AgentVersion list/read、durable Run 与 Artifact 数据面，W2-03A Rust transport extraction 已解锁。CrewON P2a 未注册 RS256 发行器、真实 Agent Platform verifier 兼容 smoke、P2b durable identity mapping/exact source adapter 已完成；隔离进程的 Provider v3 live smoke、运行中 cancel、worker crash/restart 与临时数据清理已通过。生产候选 keyset 供应/轮换、完整服务配置和真实云模型仍未完成，production feature gate 保持关闭。

## W2-03 Discovery amendment 结论

- 已增加独立 discovery delegation，固定 token type、issuer/audience、service subject、tenant/space/subject、purpose、scope、jti 和 5 分钟生命周期；它不含 Credential、taskId 或 Resource wildcard。
- Run token 与 discovery token 的 type/audience/header authority 不能互换，旧用户 access token 不进入 Provider v3 authority。
- `/provider/v3` 已增加 authenticated descriptor read、bounded exact AgentVersion resource list 和 exact manifest read；旧 `/api/v1/open/agent/*` 与 `/api/v1/crewon/catalog` 不作为 fallback。
- descriptor 只声明当前真实实现的 `durableRun`、`remoteAgent`、`resumableEvents`；未实现 approval/tool-result capability 不虚假暴露。
- catalog 只返回调用者当前可访问、Agent active/api-enabled、Version active 且 snapshot 可物化的 exact revision；manifest 只含 canonical digest，不返回 prompt、Secret 或 mutable dependency。

## 已确认事实

- `AgentRuntime.run` / `run_stream` 没有 execution id、idempotency key、cancel token、resume cursor 或 durable event sink。
- `run_stream` 会把运行异常转换成普通 message/done，不能作为可靠 terminal protocol。
- 模型循环可能触发工具外部副作用，因此 worker crash 后自动重放不安全。
- W2-02 第一版必须采用 persisted queued->running admission；claim 后丢失结果时输出 `unknownOutcome`，不自动重复启动。

## Evidence matrix

| Requirement | Harness |
| --- | --- |
| at-most-once start | duplicate worker/outbox claim executor 调用计数保持 1；Attempt 离开 queued 后不再 claim |
| restart recovery | stale processing 只产生一次 failed(unknownOutcome)，重复 recovery 为 0，executor 调用计数保持 0 |
| event replay | canonical sequence/cursor 连续，afterCursor 精确续读；unknown cursor 拒绝，不合成 gap |
| event dedupe/gap | sourceEventId/producerSequence 双唯一；相同 digest duplicate，不同事实 conflict，producer gap 拒绝 |
| terminal safety | terminal 后迟到 progress 拒绝，事件序列不增长 |
| cancel race | queued cancel 原子关闭 dispatch；running cancel/complete 竞争最多一个 terminal，loser 标 terminalWon |
| cancel liveness | execution/cancellation 双循环；foreign worker 不领取 cancel；取消 runtime 子任务后同一 worker 仍完成下一 Run；suspended cancel 不要求虚假进程内 ack |
| suspend/resume | fake executor approval suspend -> persisted mutation -> resume -> completed；重复 command 只有一个 mutation/resume outbox |
| Tool Bridge binding | contract v3 toolResultRequired + intentDigest + signed taskId；accepted event 只追加一次 |
| capability | 缺 durableRun/resumableEvents admission capabilityUnsupported；无效授权优先 forbidden，避免 capability oracle |
| error semantics | fail/timeout/unknown 映射 providerUnavailable/timeout/unknownOutcome，retryable 明确 |
| data minimization | Event 8 KiB、progress 2,000 chars、Artifact count 32；无 secret/raw token/prompt duplication |

## Commands and results

- Agent Platform：`uv run --frozen pytest tests/provider_run tests/test_provider_contract.py tests/test_agent_open_api_authorization.py -q`：210 passed。
- Agent Platform：scoped `ruff check` 通过。
- Agent Platform：`mypy app/modules/provider_run app/contracts/provider_contract.py`：45 source files，无错误。
- Permission Service：`python -m pytest tests/test_registry_sync_idempotency.py -q`：3 passed。
- CrewON：`./scripts/verify-agent-platform-provider-contract.sh`：Provider Run v3 与 Provider Discovery v1 字节等值和 SHA-256 均通过。
- CrewON：`just write-app-server-schema` 后 `just test -p crewon-app-server-protocol`：237 passed，0 skipped。
- Provider Run 生产模块均不超过 500 LoC：outbox 481 LoC、Artifact Store 458 LoC、service 425 LoC、HTTP sub-app 334 LoC、discovery application 317 LoC；职责分布在 application、parsing、models、worker、execution artifacts、discovery auth/catalog 等独立模块。

## W2-02C discovery evidence

- discovery claims 使用 strict closed model；未知字段、超长生命周期、错误 scope/purpose、Run/discovery token mix-up 均 forbidden。
- descriptor/list/read 共用 strict camelCase、extra-forbid contract；unknown capability/resource kind/cursor/authority 字段 fail-closed。
- list 候选扫描上限 100、返回上限 50，cursor 绑定数据库 row id；Permission Service 使用一次 bounded batch RPC，不产生最多 100 次串行权限调用。
- Permission Service 内部 batch endpoint 要求内部 secret，只接受最多 100 个唯一正整数 Agent id；返回值必须是候选集合的唯一子集。
- 同时修复 public registry enumeration：调用者不能通过 query 指定其他 user/tenant/space 读取权限集合。
- exact read 重新验证当前权限、UID/version identity、active/api-enabled 状态和 canonical snapshot digest；撤权、revision drift、mutable dependency 均 fail-closed。
- discovery canonical fixture 以 Agent Platform 为源，CrewON 只分发字节相同副本并记录 provenance；SHA-256 为 `f83f8199a18903e58a25414af97b60c265534ea9a4b1e5b66e5797c598c1b6a6`。

## Review boundaries

- W2-02A 未修改或包装 AgentRuntime，不注册 FastAPI router，不在 lifespan 启动 worker。
- asyncio Task/Future 不作为 Run authority；测试 executor 仅实现 port，所有状态来自临时数据库 reopen 后的 records。
- crash 后选择 unknownOutcome 而非自动重放，是现有 AgentRuntime 不能证明幂等副作用时的安全取舍。
- canonical Provider Contract 从 v1->v2 修复 Tool Intent，再由 v2->v3 修复 Task/Artifact 数据面，均为 production cutover 前显式 major 修订，不偷偷扩展 strict union。

## Production composition 边界

生产组合已在代码中条件式接入主应用：默认 `PROVIDER_RUN_ENABLED=false` 时不 mount、不创建 worker；显式启用时要求 trust keyset、service subjects、Permission Service URL/secret 和 MinIO 配置齐全，任一缺失或 readiness 失败会阻止启动。除 route/lifespan Harness 外，已用隔离进程、临时真实 RSA key、独立 Permission Service、真实 MinIO 和加密个人模型凭据完成 Provider v3 live smoke；上游模型为本地 OpenAI-compatible HTTP stub，因此该证据只证明 production composition 的真实 I/O 闭环，不代表生产密钥轮换、真实云模型或上线验收完成。

## W2-02B isolated live smoke evidence

- 使用独立 SQLite、端口、2048-bit RSA keypair、Permission Service internal secret 与 MinIO bucket；只在隔离 Agent Platform 进程设置 `PROVIDER_RUN_ENABLED=true`，默认服务和三个 production Gate 均未改变。
- discovery delegation 完成 `descriptor:read`、`resources:list`、exact `resources:read`；返回 Provider v3 capability 与唯一 `agent-version:1` manifest，list/read content digest 完全一致。
- 每个 operation 使用独立 delegation JTI；service/delegation 固定 `RS256`、`kid`、`typ`、audience、serviceAudience、subject、tenant/space、task、Credential revision 和 exact ResourceRef。
- `runs:start` 创建 durable Run，`runs:read` 从 `queued` 推进到 `completed`，`runs:listEvents` 返回连续 `runStarted -> completed`，没有客户端伪造 terminal 状态。
- worker 从不可变 AgentVersion materialization 解析 exact personal API-key route，运行时解密凭据并真实调用 loopback OpenAI-compatible `/v1/chat/completions`；Agent Platform 日志记录 `smoke-model` 200 响应。
- output 在 completed 前写入真实 MinIO：对象正文为 22 字节 `provider live smoke ok`，数据库与 HTTP header 的 SHA-256 均为 `6ba3bfe5aeb236493a957e7604c80ceb5875335e6ad6d34da56ba9f16c6b50a6`；受鉴权 `/artifacts:read` 返回同一正文。
- 临时 Agent/Permission DB、RSA key、MinIO 数据、sandbox 容器和隔离端口在验证后删除。生产密钥轮换与真实云模型继续作为 E3b2 blocker。

## W2-02B cancel/crash fault-drill evidence

- cancel Harness 先确认 Run 已进入 `running` 且 OpenAI-compatible upstream 已收到请求，再按当前 revision 提交 `runs:cancel`；Run 从 `cancelRequested` 收敛为 `cancelled`，事件严格为 `runStarted -> cancelled`。
- cancelled Run 的 dispatch/cancel outbox 均为 published，SQL 与 MinIO 都不存在该 Task 的 output Artifact；慢 upstream 最终响应不能赢过 terminal cancel。
- 同一 worker 随后完成新的 Run，事件为 `runStarted -> completed`，且只有该 follow-up Task 产生 1 个 active MinIO Artifact，证明 cancellation 没有损坏 worker loop。
- crash Harness 在 upstream 已开始且 durable Run/Attempt/outbox 均为 running/processing 后，对隔离 Agent Platform 进程执行 `SIGKILL`；没有 graceful finalize，也没有测试内伪造 terminal event。
- production worker 的 stale threshold 保持 300 秒不变；Harness 只把持久 `lockedAt` 推进到 301 秒，以等价模拟等待。使用同一 DB/MinIO 重启后启动日志明确记录 `stale recovered: 1`。
- 恢复结果只追加 `failed(unknownOutcome, retryable=false)`，事件严格为 `runStarted -> failed`；相同 idempotency key/start fingerprint 重放返回原 providerRunId 且 `created=false`，upstream `crash-slow` 调用计数保持 1，没有自动重放或 output Artifact。
- 故障演练结束后再次删除临时 DB、key、MinIO data、sandbox/container 并关闭全部隔离端口；原本地服务与 UI proxy health 继续为 200。

## W2-02B Auth transport evidence

- RS256 verifier 要求受信 kid、固定 alg/type/issuer/audience、service subject allowlist、serviceAudience、azp、Credential owner 和 exact ResourceRef。
- service credential 最大 5 分钟，delegation 最大 1 小时；expired、future iat、超长生命周期、token mix-up、unknown kid、HS256 confusion、extra authority claim 均 forbidden。
- trust keyset 和 allowed service subjects 只能来自 server-owned environment JSON；缺失、空值、重复或无效配置使用独立 configuration error fail-fast，没有开发默认 secret。
- Header boundary 只接受 `Authorization: Bearer` + 独立 `X-CrewON-Delegation` 语义；raw token 不进入 context 之外的记录。
- `uv run --frozen pytest tests/provider_run/test_auth_tokens.py tests/provider_run/test_auth_dependency.py -q`：23 passed。

## CrewON issuer Gate

- Agent Platform resolver 和 discovery application 当前严格要求 `sub=user:<positive integer>`；CrewON authenticated principal 不能未经 server-owned durable mapping 直接作为 Provider subject。
- P2a 已在独立 `crewon-provider-agent-platform::rs256_authorizer` 模块实现：固定 RS256/typ/kid/issuer/audience/purpose，service、Run、discovery 均为 5 分钟 token；每个 operation 仅签一个 exact scope，Run 同时绑定 task、ResourceRef、Credential id/owner/positive revision。
- signing key 构造执行真实签名 probe；identity 只接受 canonical `user:<positive integer>` 与 positive tenant/space。private key、identity 和 headers Debug 均脱敏，raw token 不持久化、不缓存。
- `just test -p crewon-provider-agent-platform`：36 passed；另以 stdin 将临时 token 交给 Agent Platform 真实 `ProviderRunTokenVerifier`，Run 与 discovery 两条链均通过，并验证 exact subject/tenant/space/scope/task/resource/credential revision。临时 Harness 和 token 未写入仓库或日志。
- `just bazel-lock-update` 与 `just bazel-lock-check` 通过。仓库基线三项 `aws-lc-sys 0.41.0` 补丁已按上游重排机械刷新，并通过顺序 dry-run；Bazel 已越过全部 patch application。当前本机 Bazel test 的剩余环境阻断是 hermetic macOS SDK URL 从 `swcdn.apple.com` 返回 403，仓库没有正式 local-SDK 配置，因此没有临时绕过工具链。P2a 已移除最初用于动态测试 key 的 `rcgen`，改用 test-only runfile fixture，未扩大生产 crypto backend。
- P2b-1 已在 `crewon-state` 增加 migration 0040 和内部 mapping API：固定 provider/canonical identity、active owner/target partial uniqueness、source binding 终身唯一、domain-separated record hash、terminal revoke CAS、并发单 winner 与 close/reopen deep equality；`just test -p crewon-state provider_identity` 5/5、`just test -p crewon-state` 171/171 通过。
- P2b-2a 已在 app-server 增加未注册的只读 resolver：只接受 verified authenticated principal + exact CredentialOwner + exact active mapping；cross-space、missing、revoked 和 owner mix-up fail-closed。定向 3/3、`crewon-app-server` 1037/1037 通过，1 skipped。
- P2b-1/P2b-2a 仍只是未接线的安全 kernel。P2b-2b identity-session snapshot/mutation/revoke authority 与 source freshness 完成前，不得把发行器注入 app-server/CloudWorker 生产组合。
- 当前 Agent Platform access token/logout 缺少完整 issuer/audience/JTI/revocation authority，不能作为 Provider token 或吊销源。

## W2-02B materialization and resolver evidence

- 仅接受 `agent` + `agent-version:<positive integer>`；Space 必须先由 Permission Service 证明属于 tenant，owner 之外的调用者必须通过 `execute/agent` 权限检查。
- Catalog 以 Agent UID + AgentVersion number 精确查询，并要求 Agent active、API enabled、version active；未知、跨租户、禁用资源统一 forbidden，依赖服务失败映射 provider unavailable。
- `ProviderExecutionMaterialization` 在 start transaction 内与 Run/Attempt/Authorization/Delegation 一起持久化，request fingerprint 绑定 spec digest；worker 只读取该不可变快照，不回读 mutable live Agent。
- materialization 有 64 KiB、16 层深度和 secret-field 拒绝规则；当前 AgentVersion 对 Skill/MCP/Knowledge/Workflow 仍是可变引用，因此非空复合依赖 fail-closed，不能虚假声称 exact revision。
- model binding 固定 personal API key 或 NewAPI 的 exact route id、provider/model/base URL/protocol；执行时才读取并解密 secret，route owner/status/config 漂移 fail-closed，单纯 secret rotation 允许。
- existing Run 从 persisted materialization 解析 agent identity，不依赖可硬删除 AgentVersion；每次 read/events/cancel 重新验证当前 `space:read`，撤权立即拒绝。Artifact read 使用相同 space access 与自身 owner/task metadata 约束。

HTTP sub-app 已通过默认关闭 feature gate 条件式 mount；`contextRefs` 从 Blob Store 按 snapshot digest/size/UTF-8 二次校验读取。output Artifact 使用持久 Run/Attempt 派生的内部 owner，不伪造 delegation token，并在 completed outcome 前完成两阶段激活。immutable runner 构造 detached Agent，只注入 persisted spec、verified context 和 exact model credential；未启用 Skill/MCP/KB/Workflow 的 mutable live lookup。

## Production data-plane evidence

- signed delegation 的 taskId 已进入 authorization digest、Run、Delegation、existing-run ownership 和 ArtifactRef cross-field invariant。
- Provider Artifact metadata 与正文分离：SQL 只保存 digest/size/media/sensitivity/object key/status，正文通过 Blob Store port；request/read dataclass 的正文不参与 repr。
- import 使用 pending->blob put-if-absent->active 两阶段幂等流程；Blob 故障留下不可读 pending，相同请求可恢复，不同 digest/idempotency/revision conflict。
- start transaction 锁定同 tenant/space/subject/task 的 active exact Artifact revision，按输入顺序持久化 context snapshot；缺失、过期、metadata drift 或总正文超过 256 KiB 均不创建 Run。
- worker request 只读取持久 context snapshot；input/snapshot 漂移在 executor 启动前生成 `failed(internal)` terminal，不留下假 running 或永久 queued。
- HTTP boundary 拒绝重复 JSON key/authority header、压缩或超限 body；unknown exception 只返回 canonical `internal` + traceId。Artifact import 是 64 KiB raw body，read 是 raw bytes，不把正文放入 URL/JSON/repr。
- application start 在同一事务内执行 resolver + `SELECT ... FOR UPDATE` + materialization/context binding + Run admission；Harness 证明调用方 rollback 不会被 savepoint 提前提交，重复 start 仍幂等。
- worker supervisor 启动先 stale recovery，再运行 execution/cancellation 双循环；重复 start 不生成第二组 loop，bounded stop 超时仅取消当前协程；数据库 processing record 留给下次 unknownOutcome recovery，不自动重放。
- execution Artifact reader 按 snapshot 顺序读取，二次验证 media/sensitivity/digest/size/UTF-8 和 256 KiB 总上限。
- Provider Permission HTTP adapter 要求显式 `PERMISSION_SERVICE_URL` 与非默认 `INTERNAL_API_SECRET`，拒绝 credentials/path/query/fragment URL、redirect、非 2xx、超 64 KiB 或非对象响应；不复用旧客户端的开发默认 secret。
- output writer 校验当前 running Attempt + exact executionRef/resource，使用稳定 artifact id/createdAt/idempotency；同内容重放返回既有 Artifact，不同内容 conflict。
- ProviderAgentExecutor 固定执行顺序为 persisted spec -> verified context -> materialized runner -> active output Artifact -> completed outcome；当前不支持 resume，明确返回 capabilityUnsupported。
- 外层主应用 ErrorSanitize 对 `/provider/v3/` 保留 canonical Provider error，不把 internal/providerUnavailable 改写成主站 envelope。
- 完整 Provider/W0 回归合计 210 passed；Ruff、45-source mypy、Permission Service 3 项测试、跨仓 Provider Run v3/Discovery v1 SHA-256 校验均通过。
- E3a/E3b1 已覆盖 service/delegation/discovery key、Permission/MinIO/encrypted model credential、descriptor/catalog/start/read/events/output download、运行中 cancel、worker crash/restart、unknownOutcome/idempotent replay 与清理。E3b2 仍需生产候选 key/config、轮换和真实云模型验收；全部证据完成前保持 feature gate 关闭。
