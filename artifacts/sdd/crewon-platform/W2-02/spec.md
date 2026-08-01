# W2-02 Specification: Agent Platform Provider Run 生命周期与事件

## 1. 目标与分段

W2-02 在 W2-01 的数据与授权内核上建立 Durable Provider Run 的持久生命周期。它拥有 Run/Attempt/Event/Outbox/Mutation 的权威状态，但不复制 `AgentRuntime` 模型循环。

为控制风险，按两个可独立 review 的阶段落地：

- **W2-02A Lifecycle Kernel**：状态机、事件去重与连续性、command mutation 幂等、outbox 原子 claim、fake executor、崩溃与重启 Harness。
- **W2-02B Production Composition**：service credential + signed delegation dependency、HTTP API、后台 worker 注册、真实 Agent/Workflow executor adapter 和 live smoke。

W2-02A 不注册生产路由、不启动后台任务；W2-02B 只有在 A 的 Harness 通过后才能接线。

## 2. 现状审计结论

当前 `AgentRuntime.run` / `run_stream` 不是 durable executor：

- 没有 execution id、idempotency key、取消令牌、resume cursor 或 durable event sink；
- `run_stream` 会把 PermissionError、ValueError 和未捕获异常折叠成普通 `message` + `done`，调用方无法可靠区分成功与失败；
- 模型循环内部可能执行 MCP、Skill、Workflow、沙箱和其他带外部副作用的工具；
- 进程崩溃后无法证明模型循环“尚未开始”或“尚未产生副作用”。

因此禁止把现有 one-shot chat/SSE 包装成可恢复执行。第一版真实 adapter 使用数据库原子 admission 保证**同一 Attempt 至多启动一次**；一旦 Attempt 离开 `queued`，进程崩溃或结果丢失都不得自动重新调用模型循环，而要输出 `unknownOutcome`，由上游 Task Runtime 进入 reconcile。

## 3. Executor Port

Lifecycle 只依赖窄接口：

```text
ProviderRunExecutor.execute(ExecutionRequest, EventSink) -> ExecutionOutcome
ProviderRunExecutor.cancel(ExecutionRef) -> CancelOutcome
```

- `ExecutionRequest` 只包含 run/attempt/execution ref、exact ResourceRef 和 bounded canonical input；不包含 Credential secret、delegation token 或 HTTP header。
- `EventSink` 接收带 `sourceEventId`、`producerSequence`、type 和 bounded payload 的事实。
- `ExecutionOutcome` 是闭集：completed、failed、cancelled、unknown。
- adapter 不决定 Run 状态，不直接写数据库。
- fake executor 可确定性产生 progress/suspend/complete/fail/timeout/unknown，用于 Harness。

真实 Agent adapter 只调用既有稳定入口，不复制 `_run_loop` / `_run_stream_loop`。因为现有入口不能恢复，adapter capability 为 `atMostOnceStart=true`、`inProcessCancel=bestEffort`、`resumeAfterCrash=false`。

## 4. 状态机

### 4.1 Run / Attempt

```text
queued -> running -> suspended -> running -> completed
                  \-> failed
                  \-> cancelled
                  \-> unknownOutcome(failed event)
```

- `queued -> running` 只能由 outbox claim transaction 完成。
- terminal 为 `completed | failed | cancelled`，终态不可逆。
- `suspended` 必须存在一个 pending suspension。
- `unknownOutcome` 使用 `failed` terminal event，error code 为 canonical `unknownOutcome`、`retryable=false`；Provider 不自动重试。上游可以基于新 Task Attempt 发起新的 Provider Run，但不能复用本 Attempt。
- `reconciling` 保留给未来具有远端 execution query 能力的 provider；当前 AgentRuntime adapter 不伪造 query/resume 能力。

### 4.2 Cancel

- cancel command 以 `commandId` 幂等，并带 expected revision。
- queued：同一事务终止 Run/Attempt、关闭 dispatch outbox、追加 cancelled event。
- running/suspended：持久化 cancel request；只有 executor 明确确认后追加 cancelled terminal event。
- running 的 cancel outbox 只能由持有对应 dispatch/resume claim 的同一 worker 实例领取；其他副本不得把“本进程没有该 executionRef”误判为取消失败。
- worker 使用独立 execution/cancellation poll loop；AgentRuntime 运行在可取消子任务中，取消单次执行不得终止 worker execution loop。suspended 没有进程内任务时无需伪造 executor acknowledgement。
- completed/failed：返回 conflict；已 cancelled 的同 digest 重放返回原结果。
- cancel 与 terminal 事件竞争时，数据库 revision/status CAS 最多允许一个 terminal transition；迟到事件被记录为受控 conflict，不改变权威状态。

## 5. Event Stream

- canonical `sequence` 从 1 连续递增，cursor 固定为 `event-{sequence:04}`；客户端 cursor 只能指向 0 或真实存在的 event。
- executor fact 使用 `(attemptId, sourceEventId)` 和 `(attemptId, producerSequence)` 双唯一约束。
- 相同 sourceEventId + 相同 canonical digest 返回 duplicate；相同 key + 不同内容 conflict。
- `producerSequence` 必须从 1 连续递增；gap 不补洞、不推进 Run。
- 事件 payload 采用 event-type allowlist 和硬上限；progress summary 不保存无限模型正文，Secret/raw tool payload 不进入 Event。
- terminal 之后的 provider event 一律拒绝，不新增 sequence。
- list events 使用 ownership authorizer，在同一事务消费 delegation jti、记录 decision 并读取快照，避免授权检查与读取分离。

## 6. Outbox Claim 与崩溃语义

dispatch claim 必须在单个 transaction 中：

1. `SELECT ... FOR UPDATE SKIP LOCKED` 选择 `pending` 且可用的 outbox；
2. 验证 Run/Attempt 都是 `queued`；
3. 生成持久 `executionRef`；
4. CAS 更新 Run/Attempt 为 `running` 并增加 revision；
5. 更新 outbox 为 `processing`，写 `lockedBy/lockedAt` 和 attempts；
6. commit 后才允许调用 executor。

重复 worker、重复 outbox delivery 或服务重启看到 Attempt 已非 queued 时不得再次执行。

如果 `processing` 超时：

- 不回到 pending；
- 原子转为 Run/Attempt `failed`，outbox `failed`；
- 追加唯一 `failed(unknownOutcome)` terminal event；
- 后续重复 recovery 幂等。

这会牺牲“崩溃发生在真正调用 executor 之前时的自动恢复”，但避免对可能已经执行 MCP/工具副作用的模型循环做不安全重放。只有未来 executor 提供可查询 executionRef 的外部幂等协议后，才能引入 `reconciling -> resume/query`。

## 7. Suspend / Resume 与 Mutation 幂等

- pending suspension 持久化 type、target id、expected intent/action digest、expiry 和状态。
- approval decision 绑定 `(approvalId, actionDigest)`；tool result 绑定 `(toolCallId, intentDigest, resultDigest)`。
- mutation receipt 唯一键为 `(runId, operation, idempotencyKey)`，目标唯一键防止同一 approval/tool call 被不同 key 解析两次。
- 相同 key + 相同 request digest 返回原 result revision；相同 key/target + 不同 digest conflict。
- mutation 与 `toolResultAccepted` event、suspension resolve、Run revision 变化在同一 transaction。
- 真实 AgentRuntime 尚无安全 suspend/resume port 时，对应 production capability 不得启用；fake executor 仅验证 lifecycle kernel。

## 8. Capability Admission

Resource authorization 必须显式声明 capability。start 至少要求：

- `durableRun`
- `resumableEvents`

缺任一项返回 `capabilityUnsupported`，不得退回 one-shot chat。`approval`、`toolResult` 只有真实 adapter 支持持久 suspend/resume 时才对该 Resource 开放。

## 9. Transaction 与授权边界

- read/events/cancel/approval/tool-result 不能先调用公开 `authorize_existing_run` 再另开 mutation transaction。
- W2-02 提供一个 transaction-internal owned-run authorizer：在同一 transaction 内重验 tenant/space/subject/Credential owner/exact ResourceRef/current resource scopes，消费 jti、写 decision，然后读或改状态。
- existing Run 的资源身份来自持久化 `ProviderRunMaterialization`，不得回读可能已硬删除的 AgentVersion；同时必须通过 Permission Service 重新验证当前 `space:read`，撤权后 fail-closed。Artifact read 使用同一空间权限边界，并继续由 Artifact metadata 的 tenant/space/subject/task 精确绑定决定可见性。
- HTTP raw claims 不得直接构造 `ProviderRunAuthorizationContext`；W2-02B dependency 必须验证 service credential 和 delegation signature/issuer/audience/expiry 后才能构造。
- 不返回 foreign/unknown Run 的差异；均为 `notFound`。

### 9.1 W2-02B Signed transport

现有 Space API Key 是用户/Space Open API credential，现有 `X-Internal-Secret` 是单一共享 secret，均不具备 Provider Run 所需的 caller subject、audience、短期 expiry、kid rotation 和 signed user delegation；不得复用为 production Provider service credential。

W2-02B 使用 CrewON 签名、Agent Platform 只持公钥的 RS256 双 token：

- `Authorization: Bearer <serviceCredential>`：`typ=crewon-service+jwt`、`iss=crewon`、`aud=agent-platform-provider-api`、`sub=crewon-app-server`、serviceAudience、jti、iat、exp；生命周期最多 5 分钟。
- `X-CrewON-Delegation: <delegation>`：`typ=crewon-delegation+jwt`、`iss=crewon`、`aud=agent-platform-provider-run`、`sub=user:<numericId>`、`azp=service sub`、tenantId、spaceId、purpose、scopes、`CredentialRef(id, ownerSubject, exact positive revision)`、exact ResourceRef、jti、iat、exp；生命周期最多 1 小时。
- JOSE header 必须是 `alg=RS256` 且有受信 `kid`；Agent Platform 从 server-owned keyset 解析，拒绝 token 自带的 jwk/jku/x5u，不持有私钥。
- 两个 token 的 `azp/sub`、issuer、audience 和时间必须绑定；raw token 不进入 DB、Event、日志或 error response。

CrewON 签发端按独立 P2a/P2b 两阶段落地：

- **P2a（未注册发行器）**只负责用 server-owned RS256 private key 为一个已经验证的精确 operation 生成 service + delegation/discovery token。header、issuer、audience、purpose、scope、生命周期和 exact Resource/Credential revision 必须与本节以及 Agent Platform verifier 字节语义一致；每个 token 使用独立 JTI，不缓存 raw token。
- P2a 接收的 Agent Platform subject 必须已经是 `user:<positive integer>`。这是当前 Provider resolver/discovery application 的真实输入契约，不允许把 CrewON opaque principal、客户端 user id、旧 access token subject 或 display name 直接填入。
- **P2b（durable owner mapping）**负责把 authenticated principal 通过服务端权威映射到 Agent Platform tenant/space/user subject，并证明 Credential owner 与该 subject 一致。P2b 完成前，P2a 只能作为未接线的内部组件和跨服务 Harness 使用。
- signing key 构造必须 fail-fast 校验 PEM/RS256 可签名性；key id、principal/tenant/space 均有硬上限并拒绝空白、控制字符和非 canonical 正整数。private key、service/delegation token 不得实现可泄漏的 Debug/Display/Serialize。
- 当前 Agent Platform 用户 access token 只含旧 claims，logout 只做客户端删除，不具备 Provider issuer/audience/JTI/revocation 语义；两者都不得被包装或复用为 P2a 输入。

HTTP dependency 只能从验签后的 claims 构造 `ProviderRunAuthorizationContext`；body 中出现 authority 字段必须由 strict request schema 拒绝。

### 9.2 Resource resolver discovery

- Agent/Workflow 表有 spaceId 和 owner，但 tenantId 只能通过 Permission Service 的 Space authority 解析；服务不可用时必须 fail-closed。
- AgentVersion/WorkflowVersion 提供顶层快照，但当前 Catalog 尚未发布统一 Resource revision，Agent snapshot 引用的 Skill/MCP/KB 也没有组合 revision；因此 production start 不得把 mutable live row 声称为 exact revision。
- W2-02B 在注册 start API 前必须先落 `ProviderExecutionMaterialization`：把 exact published Agent/Workflow revision 解析成有界、不可变执行输入；如果任一 provider-managed dependency 无稳定 revision，则 capability/admission 返回 unsupported，而不是回退 live one-shot。

### 9.3 Task binding 与 Artifact 数据面

v2 仅有 `contextRefs: string[]`，且 signed delegation 没有 taskId；这不足以生成或消费 contract 中要求 taskId 的 ArtifactRef。W2-02B 在 production cutover 前升为 Provider Contract v3：

- signed delegation 必须携带 bounded taskId，ProviderRunAuthorizationContext、Run、Delegation 和 authorization digest 全部绑定它；existing-run 操作 taskId 不一致统一 not found。
- start 的 contextRefs 使用 strict ArtifactRef，不接受 URL、绝对路径、自由字符串或 inline payload。
- context Artifact 必须先通过独立 import API 写入 Provider-owned bounded store；metadata 绑定 tenant/space/subject/task/media type/digest/revision/retention，正文不进入 Run input、Event 或 Outbox。
- start transaction 只接受同 tenant/space/subject/task、未删除、未过期且 revision 精确匹配的 context Artifact；缺失或越权统一 forbidden/not found，store 不可用返回 providerUnavailable。
- real adapter 读取已校验的本地 Provider Artifact，不回调任意 URL，不使用 presigned URL 作为持久 authority。
- AgentRuntime 输出先写 Provider Artifact Store，再产生 completed event；所有 output ArtifactRef.taskId 必须等于 Run 的 signed taskId。
- CrewON 后续通过鉴权 download API 拉取 Provider Artifact 并提交到中央 Artifact Store；Provider Artifact 保留自身 revision/digest/retention，不与 CrewON SQLite 共享数据库。

第一阶段只允许 bounded text context/report；文件、图片或 Secret payload 在相应存储/扫描/加密能力落地前 fail-closed。空 contextRefs 可以执行，但非空 contextRefs 绝不能被静默忽略。

## 10. Bounds 与数据最小化

- 单个 Event payload 最多 8 KiB；progress summary 最多 2,000 Unicode 字符。
- list events limit 为 1..100。
- source event id、execution ref、command id、target id、idempotency key 均有 byte cap。
- mutation payload 最多 8 KiB；Artifact 只保存 canonical ArtifactRef，不保存文件内容。
- taskId 最多 255 bytes；context Artifact 最多 32 项，引用总 JSON 计入 64 KiB input cap。
- error message 使用 code + bounded safe summary；不写 exception traceback、Credential、token、prompt 或 raw tool result。

### 10.1 Provider v3 HTTP boundary

- Provider API 以独立 FastAPI sub-application 组合，显式 mount 到 `/provider/v3` 才会生效；构造 HTTP app 不得隐式注册主路由或启动 worker。
- HTTP 层只依赖 `ProviderRunApplication` 窄端口，不直接持有 SQLAlchemy session、Catalog 或 AgentRuntime，避免 transport 与 transaction/runtime 耦合。
- command body 只接受 `application/json`，最大 128 KiB；拒绝重复 JSON key、重复 authority header、压缩 body 和 strict schema 之外字段。
- Artifact import 使用 raw bounded body，最大 64 KiB；正文不进入 URL、日志、repr 或 JSON envelope。Artifact read 返回 raw bytes 与 digest/metadata header。
- Provider error 统一返回 canonical `ProviderContractError`；未知异常只映射 `internal` + server traceId，不回传 exception、prompt、token 或存储细节。
- 主应用外层错误中间件必须对 `/provider/v3/` 保留 Provider canonical error envelope，不能二次改写为主站错误格式。
- start application composition 在同一数据库事务内完成 Catalog exact revision lock、materialization、context binding、Run/Event/Outbox admission；并发唯一键只能在外层事务 rollback 后进入显式幂等恢复，禁止通过 SQLite savepoint 意外提交调用方事务。

### 10.2 Worker supervisor

- worker 启动先执行一次 stale `processing` recovery，再启动独立 execution/cancellation bounded poll；recovery 仍使用 `unknownOutcome`，不重新 dispatch 非 queued Attempt。
- 重复 start 不创建第二组 loop；stop 有 bounded graceful timeout。超时只取消当前进程协程，让仍为 `processing` 的权威记录在下次启动按 stale claim 处理。
- asyncio Task/Event 只承担进程内调度和停机信号，不作为 Run、Attempt、Event 或 retry authority。

### 10.3 Provider discovery authority 与 exact catalog

W2-03 Rust Adapter 需要 Provider descriptor/capability 和 Resource Federation list/read，但 Run delegation 强制绑定 exact Resource/Credential/task，不能用于 provider-level discovery。W2-02C 增加独立边界：

- discovery delegation 使用独立 audience/purpose 和短期 expiry，绑定 service、tenant、space、subject、scopes、jti；不携带 Credential、taskId、Resource wildcard 或客户端路径。
- `descriptor:read` 只声明实际已实现能力：durableRun、resumableEvents、remoteAgent，以及 Agent/providerManaged/provider 资源组合；approval/toolResult/Workflow 在真实 adapter 未实现前不得广告。
- `resources:list` 只返回当前 subject 在 exact tenant/space 可访问、Agent active/api-enabled、AgentVersion active 的 exact `agent-version:<n>`；limit、cursor、candidate scan 和 Permission 调用次数均有硬上限。
- `resources:read` 返回 exact ResourceRef、manifest schema version 和 immutable AgentVersion snapshot canonical digest；不返回 prompt、Model route、Credential、snapshot 正文或 mutable latest。
- discovery token 不能 start/read/cancel Run，Run token 也不能 list catalog；claims shape、audience、purpose 和 scope mix-up fail-closed。
- 旧 `/api/v1/open`、CrewON mutable catalog 和 wildcard Resource 均禁止作为 fallback。

## 11. W2-02A 验收

1. fake executor 覆盖 progress/suspend/complete/fail/timeout/unknown。
2. duplicate claim/outbox/event 不重复执行或追加事件。
3. worker crash/reopen 后 stale claim 只生成一次 `failed(unknownOutcome)`，不重新调用 executor。
4. cursor replay、invalid cursor、producer gap、terminal late event fail-closed。
5. queued/running cancel race 最多一个 terminal；approval/tool result digest/idempotency 不重复恢复。
6. capability 缺失 fail-closed。
7. 目标 pytest、W0/W2 contract regressions、ruff、mypy 和 schema/static scans 通过。

## 12. 非目标

- 不重写 AgentRuntime 或 Workflow engine。
- 不承诺当前 AgentRuntime 能在进程重启后 resume。
- 不用 asyncio Task/Future/内存队列作为 Run 权威。
- 不在 W2-02A 注册 HTTP API、lifespan worker 或生产流量。
- 不自动重试 unknown outcome。
- 不把无限模型正文、Secret、raw MCP/tool payload 写入 Event/Outbox/Mutation。
- production composition 默认关闭；只有显式 `PROVIDER_RUN_ENABLED=true` 且 trust keyset、Permission Service、MinIO 全部通过 fail-fast 配置与 readiness 后，才 mount Provider sub-app 并启动 worker。
