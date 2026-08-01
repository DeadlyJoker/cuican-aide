# W2-07 Specification: CloudWorkerExecutor 与 Provider Event 映射

状态：独立组件 Gate Green，尚未生产接线。Task Contract v2、immutable `CloudExecutionSpec`、metadata-only resolver、Attempt 级 Provider Run Journal、`WorkerOutcome::Cancelled`、start/event/cancel/reconcile、跨服务 credential revision，以及 Agent Platform claim/digest/persistence/ownership 均已通过 Harness。CloudWorker 每次外部调用都会从 State 重验 active connection、exact access grant、fresh identity mapping 和 resource binding，再创建 task-scoped Provider client；State 还提供最多 100 条的 non-terminal Run restart recovery page。常驻监督循环、scheduler/outbox 注册和进程生命周期由 W2-08 中心 composition 拥有，本模块保持未注册。

## 1. 已确认事实

- 原 `WorkerDispatch` 只有 Task/Attempt/WorkerRun/Lease、idempotency key、WorkspaceKey 和 resource bindings；P1 已加入 immutable `ExecutionSpecRef`。
- Provider start 必须拥有 exact Agent resource、CredentialId、prompt、context refs、command/request digest；这些不能由 UI 临时补充。
- 原 `TaskContract` 没有 immutable execution input ref，重启后无法证明重建的是同一 start 请求；P1/P2 已通过 ref + immutable spec 关闭该缺口。
- 原 `WorkerExecutor::start` 返回 `ExecutorRunRef`，但 Task Aggregate/State 没有持久保存 providerRunId/attemptId/cursor/revision；P3 已增加 Provider Run Journal。
- 原 `WorkerOutcome` 没有 Provider 主动 `cancelled` 的安全表达；P4 已增加闭集事实并冻结 Authority 边界。

## 2. 必要前置 A：Immutable Execution Spec

Task Runtime 已增加通用、无 Secret、无正文的 `ExecutionSpecRef`：

- bounded `executionSpecId`；
- non-zero immutable revision；
- canonical SHA-256 digest。

它已进入 `TaskContractSpec`、`TaskContractSnapshot`、canonical contract hash 和 `WorkerDispatch`，并由 restore/tamper Harness 验证。Task Contract schema 已提升并限定为 v2；资源 binding 先按 bindingId canonicalize，再参与 hash。具体 Provider prompt/context/Credential 仍不进入 Task Aggregate。

app-server/state 提供 immutable `CloudExecutionSpec` record，至少绑定：

- TaskId、WorkspaceKey、exact Agent binding/resource revision；
- CredentialId + expected credential revision，不含 Secret；
- bounded prompt payload/Artifact ref 与 bounded context Artifact refs；
- execution spec revision/digest、createdAt。

CloudWorker 读取后必须重算 digest，并校验 Task/Workspace/resource/Credential revision；任何 drift 都拒绝 start。

当前 resolver 已实现上述校验，并额外保证：Context 只读取 metadata，不批量加载正文；prompt 在正文读取前先校验 payload metadata、MIME 与 64 KiB 上限；Artifact schema、workspace、可用性、expiry、Task correlation 和 payload digest 全部 fail-closed。Conversation-correlated输入允许进入新 Task，但若 Artifact 已具有 Task correlation，则必须与目标 Task 精确一致。

## 3. 必要前置 B：Provider Run Journal

在现有 `crewon-state` 生命周期内增加 bounded journal，不新建第二数据库：

- TaskId + AttemptId 唯一，一个 Attempt 只能对应一个 Provider Run；
- 初次 start 的 WorkerRunId 作为 admission audit 字段保留，Worker reclaim 不创建第二个 Provider Run；
- exact provider/resource/credential revision；
- providerRunId、providerAttemptId、provider revision；
- last accepted provider sequence/cursor；
- start command/request digest 与 status；
- CAS version、created/updated timestamps。

start 先读取 Attempt 级 journal；已有记录时直接复用 providerRunId，不再解析 Secret/prompt 或调用 Provider。首次 start 使用不包含 WorkerRunId 的 deterministic command/idempotency input 调 Provider，再以 compare-or-insert 保存完全相同结果。相同 Attempt 的语义等值重放只接受等值 mapping；不同 providerRunId/digest 为 conflict/unknown，不能覆盖。journal canonical hash 不包含本地写入时间，避免并发等值重放因本机时间不同产生伪冲突。

State 已在现有 `state_5.sqlite` 迁移中实现 immutable spec、ordered context refs、journal 与 event receipts；journal advance 使用 `BEGIN IMMEDIATE` + expected version/sequence/cursor CAS，事件 ID、sequence 和 cursor 均唯一。数据库不保存 prompt 正文、Secret 或 raw Provider payload。

## 4. 必要前置 C：Worker cancellation fact

扩展 Worker 事实闭集以表达 Provider/Worker 主动取消，但不让 Executor直接裁决 Task：

- `WorkerOutcome::Cancelled` 将当前 Attempt 置为 Cancelled；
- 若 Task Authority 已先提交 `CancelTask`，迟到 Provider cancelled 只审计/Inbox 去重，不回退终态；
- 若 Provider 主动取消，Task 进入 Authority retry/final-decision 路径，而不是自动标记用户取消。

该 reducer 语义已在 task-runtime integration Harness 中冻结。Authority cancel 后即使原 lease 已过期，也能从终态 Aggregate 重建精确 cancellation evidence，供 durable outbox/restart 重放；这不会重新开放 Worker 对 Task 终态的裁决权。

## 5. CloudWorkerExecutor 边界

app-server 已在独立、未接线模块中实现：

1. 从 dispatch 中选择唯一 `ProviderManaged + Provider + Agent` binding；0 或多于 1 个均拒绝。
2. 解析并验证 ExecutionSpec/Credential/Context，再构造 W2-03 `ProviderRunStartRequest`。
3. start/cancel/reconcile 只操作 Authority 已创建的 Attempt，不创建 Attempt、不决定 retry。
4. event pump 从 journal cursor 拉取 typed page，将可映射事件构造成带当前 lease/fencing 的 Worker fact。
5. Task Inbox/commit 成功后再推进 journal cursor；若 cursor 写失败，重放由 Provider eventId + Task Inbox receipt 去重，只补 journal cursor，不重复 Task transition/outbox。
6. cancel 先读取 Provider 当前 revision，再以 exact providerRunId/revision 发出稳定命令；Provider 已终态时不重复 cancel。
7. reconcile 只读取并校验同一 Provider Run 的 attempt/sequence，不创建新 Attempt、不决定 retry，也不替代 event pump 提交业务事实。
8. 每次 start/read/events/cancel/reconcile 都从 durable State 重验 active connection、exact grant/revision/scope、source binding/revision/freshness 和 Agent resource binding；不缓存跨任务 CredentialOwner，也不读取或保存 Agent Platform 的模型 Secret。
9. Provider client 由默认关闭、endpoint-pinned、RS256 的生产 factory 按本次验证后的 `ProviderAuthorizationIdentity` 创建，避免进程级固定身份串到其他用户或 Workspace。
10. State 以稳定 `(taskId, attemptId, workerRunId)` cursor 分页列出 non-terminal journal，limit 为 1..100，供 W2-08 在 app-server restart 后恢复监督；查询本身不重放 start/cancel 或 Task transition。

该模块尚未注册到生产 scheduler/outbox。W2-07 只交付确定性的单页 event pump 和 bounded recovery input；监督、backoff、关闭、并发上限、恢复扫描循环与 scheduler/outbox 注册是 W2-08 唯一中心接线职责，不能把一次性 Harness 调用当作常驻运行时，也不能反过来把 W2-08 的职责作为 W2-07 的循环前置。

## 6. Provider Event 映射

| Provider event | Task/Worker fact |
| --- | --- |
| runStarted | journal-only control fact；不伪造业务进度 |
| progress | `Progressed` |
| completed | `Succeeded`，Artifact refs 另走 Artifact adapter/audit |
| failed（known terminal） | `Failed`，retry 由 Authority决定 |
| failed（unknownOutcome）/transport unknown | `OutcomeUnknown` -> reconcile same run |
| cancelled | `Cancelled` -> Authority decision；已终态则只去重/审计 |
| approvalRequired | 当前明确 Unsupported；仅 capability 真正开放后映射 `Suspended(ApprovalRequired)` |
| toolResultRequired | 当前明确 Unsupported；仅 capability/bridge Gate 开放后映射 `Suspended(ProviderPaused)` |
| toolResultAccepted | 当前明确 Unsupported；开放后才允许对同一暂停 Attempt `Resumed` |

当前 Agent Platform 未开放 approval/tool-result mutation route，W2-03 会对这些未声明事件 fail-closed；W2-07 不模拟 resume。

Provider authorizer 的内部 binding 已加入 expected Credential revision，使 CloudWorker 无法只传 CredentialId。Agent Platform delegation claim 现已强制携带 positive `credential.revision`；验签后 revision 进入 server-owned authorization context、authorization digest、start fingerprint、Provider Run/Delegation records 与 existing-run ownership。Credential ID 或 revision drift 对 foreign/unknown Run 使用相同 `notFound` 语义，且不消费新 delegation JTI。

双方 canonical Provider Contract v3 已在 production cutover 前同步为 required `credential.revision`；v1/v2 历史 fixture 不回写。缺少或为零的 revision fail-closed。Authenticated Principal P1a/P1b 与 P1c transport revocation contract 已完成稳定身份、WebSocket verified claims、expiry/revoke disconnect 和 RemoteControl no-principal Gate；P2a 已提供真实 RS256 service/delegation/discovery 发行器并通过 Agent Platform verifier，P2b durable mapping、exact owner、authoritative source/freshness 与 durable workspace adapter 也已完成。Provider production factory 已提供默认关闭的 endpoint/key-file 配置，CloudWorker 只消费服务端 State 授权事实并按任务生成短期调用身份，不能直接消费客户端 claim、旧用户 access token、本地共享 Secret 或模型 Secret。真实部署 key provisioning、真实云模型 smoke 属于 release evidence，不阻塞 W2-08 建立默认关闭的 hermetic composition，但未通过时不得切生产流量。

## 7. Harness

- Task/ExecutionSpec/RunJournal 的 create-close-reopen deep equality。
- start 重放、Worker reclaim、响应后 journal 写失败/冲突、journal 成功后响应丢失、providerRunId conflict。
- duplicate/out-of-order/cursor gap、旧 Attempt/Worker/lease、app-server/provider restart。
- Task commit 成功而 cursor advance 失败后的重复事件只产生一次 transition/outbox。
- Credential revoke/revision drift、context task/workspace mismatch、多个 Agent binding、Secret/request scan。
- cancel current-revision、Provider 已终态、reconcile same-run、Authority terminal race。
- connection/grant/source mapping/resource revision drift 在每次 Provider I/O 前 fail-closed；不同任务使用各自 task-scoped client identity。
- bounded recovery page 覆盖 cursor、limit、non-terminal inclusion、terminal exclusion，且查询不产生外部副作用。

## 8. 停止条件

- 没有 immutable ExecutionSpecRef 时不从 UI/内存拼 start 请求。
- 没有 durable run journal 时不使用内存 Promise 或 WorkerRunId 猜 providerRunId。
- Provider event 无安全映射时进入 unknown/reconcile 或明确 unsupported，不吞掉、不猜终态。
- W2-08 未完成受监督 event pump、bounded recovery、关闭语义和 scheduler/outbox 注册前，不注册 production CloudWorker。
- 真实部署 key provisioning 或真实云模型 smoke 未通过时，不切生产流量；不得用旧 chat、固定进程身份或本地 Secret fallback。
