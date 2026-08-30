# W2-07 Implementation Plan

## Stage D: Discovery（已完成）

1. 审计 TaskContract/WorkerDispatch/WorkerOutcome、State Task records 和 W2-03 Run client。
2. 识别 execution input、Credential revision、providerRunId/cursor journal 与 cancelled fact 缺口。
3. 暂停 CloudWorker 直接接线，禁止内存 Promise/旧 chat fallback。

## Stage P1: Task execution reference amendment（已完成）

1. [x] Harness Red：证明 snapshot/dispatch 无法携带 execution spec ref。
2. [x] 新增 bounded `ExecutionSpecRef`，进入 Contract/Snapshot/WorkerDispatch 与 canonical contract hash。
3. [x] Task Contract schema 提升并限定为 v2，restore 重算 hash，binding 顺序 canonicalize。
4. [x] 更新 task-runtime/state adapter fixtures，运行 task-runtime/app-server restart Harness。

## Stage P2: Cloud execution spec + run journal

1. [x] 设计 state records/migration、CAS 和 reopen Harness。
2. [x] 建立 app-server resolver port，验证 exact task/workspace/resource/credential/context digest。
3. [x] 建立 run journal create/read/advance/status API，不保存 Secret/raw provider body。
4. [x] Artifact context 使用 metadata-only read，prompt 先检查 metadata/上限再读取正文，避免 32 x 8 MiB 放大。
5. [x] Provider Run authorization binding 增加 expected Credential revision；外部 delegation claim 的跨服务落地保留为 composition 前置。

## Stage P3: Cancelled worker fact（已完成）

1. [x] 冻结 reducer transition：Worker/Provider 主动 cancelled 只结束当前 Attempt，Task 进入 Authority 的 RetryDecision，而不是伪造成用户取消。
2. [x] 冻结 terminal race：Authority 已终结 Task 后，迟到 cancelled 不回退 Task；Provider journal 仍可完成审计与去重。
3. [x] 更新 worker/event/store/snapshot/reopen Harness，并保留 Authority cancel 后可重建的精确 Worker cancellation evidence。

## Stage C: CloudWorkerExecutor（独立组件 Gate Green，未接线）

1. [x] start + Attempt 级 compare-or-insert journal；Worker reclaim 复用同一 Provider Run。
2. [x] event page mapping + Task Inbox commit + post-commit cursor advance；cursor 写失败后依靠 Inbox receipt 安全重放。
3. [x] cancel read-current-revision + exact cancel；reconcile 只读取并校验同一 Provider Run，不创建 Attempt 或决定 retry。
4. [x] restart/replay/冲突 journal/terminal race/credential revision/secret redaction Harness。
5. [x] 完成外部 Agent Platform delegation/token claim 的 Credential revision 验签、authorization digest、Run/Delegation persistence、existing-run ownership 与双方 canonical v3。
6. [x] 使用 authenticated principal 派生的 durable identity mapping、active Provider Access Grant、connection/resource revision 实现 secret-free authority resolver；每次 Provider I/O 都重验，不缓存跨任务 owner。
7. [x] 以默认关闭、endpoint-pinned、RS256 production factory 创建 task-scoped Provider client；真实 Provider verifier/live/cancel/crash smoke 已完成。
8. [x] 增加 bounded non-terminal Provider Run recovery page，供中心 supervisor 在 restart 后恢复监督；查询不重放副作用。
9. [ ] 由 W2-08 实现 supervised event pump、backoff/关闭/restart 扫描及 scheduler/outbox composition；W2-07 不拥有中心生命周期。
10. [ ] 在发布 Gate 补齐部署环境 key provisioning 与真实云模型 smoke；它不阻塞默认关闭的 W2-08 composition，但阻止生产流量切换。

## Gate

W2-07 独立组件 Gate Green：authority、task-scoped client、Run lifecycle、event mapping、幂等 journal 和 restart recovery input 均可供中心 composition 消费。W2-08 已解锁，负责唯一的 supervisor/scheduler/outbox 注册与默认关闭接线；W3-01 仍必须等待 W2-08 Wave Gate，以及部署 key provisioning、真实云模型 smoke 和切换清单。当前 CloudWorker 刻意未注册到生产路径。
