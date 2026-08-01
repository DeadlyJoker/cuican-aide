# W3-03 Specification: Office Migration Fence, Quiescing, and Importer

状态：Stage K、Stage I1、Stage I2a、Stage F1a 与 Stage F1b Green；F1b 的 production `StateDbHandle` injection 已确认闭合，新增 `state_db=None` in-process migration fence Harness 也已 Green。Stage F2a 已完成首轮 run/dispatch fence 接线，F2b 已完成跨 run/delegation/verification 外部 start 到 commit 的 linear `OfficeDispatchPermit`，并闭合 scheduler exact `intentId` 预阶段。P0b core 的 durable marker/resume index、default-off idle admission、reservation-aware task start、effective-cwd precondition与 v2 Durable Execution Fence已 targeted Green：顺序固定为 `v2 admission flush -> matching executionFence flush -> task start`。Office仅能显式恢复 exact v2 admission-only/no-fence/no UserMessage-or-lifecycle evidence；legacy v1、unknown phase、persisted-without-fence和fenced-without-exact-active/terminal evidence均 fail-closed。writer fault Harness 7/7 Green（run `11def95f-63ba-4b8a-bc0d-d83f383c5154`），resume index 13/13 Green（run `506976a8-a4a7-4efa-a718-a9d764f9261b`）。Office stable identity、exact prompt snapshot、versioned delegation receipt、default-off Auto Delegation writer/reader、exact physical-path recovery、scheduler admitted sidecar CAS、exact v2 admission recovery、legacy v1 quarantine、exact active attach及 Office-first scheduler-lagging partial-commit收敛均已有 targeted Green 证据；最新 combined durable filter 9/9 Green（run `d88fd93d-a716-4a96-b4f8-0064bc35c39b`）。local rollout single-writer/handoff 已 targeted Green：per-thread OS lease覆盖 live writer、cold metadata、compression、archive/unarchive/delete，resume 在 lease 内重读并 exact 校验 durable history；真实双 app-server graceful handoff、异常退出 lease 释放与 writer conflict 映射均 Green。generation lock substrate也已 targeted Green：lock matrix 6/6（run `435432c6-bd5e-4dc1-8113-ca4f430d90c3`）、rollout 84/84（run `542733ca-066a-4c2c-aa53-7939373800f1`）、app-server默认 `LeaseAwareShared` 2/2（run `bd8a7a23-2b30-4743-a1e7-cf80128f39f0`）、legacy feature `LegacyFenceExclusive` 2/2（run `a1b67eea-3d17-4f04-9cdd-ffa839fac47c`）。但 F2b-3d6c 仍未完成：Legacy marker mutation fence 的 Stage A rollout边界和Stage B ThreadStore SQLite-only/rename/delete边界正在实现，Stage C legacy feature force-off与Stage D immutable artifact build/production launcher/container wiring尚未闭合。standalone SHA verifier 10/10 Green但明确输出 `productionWiring:notConnected`，不能关闭SHA Gate。不启动 turn 的 `executionUnknown` reconcile、downstream model/tool/MCP idempotency/reconcile、真实 power-loss/fsync 与 NFS 锁语义、其余多文件故障矩阵、migration-vs-dispatch 竞态、migration-owned reconcile、Office storage authority cutover、strict corrupt legacy quarantine 和 storage/memory sidecar 边界仍未闭合。production importer与 durable Office feature继续 disabled，F2/F3 与整体 Gate保持 Red/default-off。

## 1. 目标与用户结果

W3-03 为现有 JSON/sidecar Office 权威建立逐 Aggregate、单向、可恢复的迁移边界。未开始迁移的 Office 继续由旧链独立运行；一旦进入 `quiescing`，旧 record mutation 和 dispatch 必须 fail-closed，不能与后续 Typed Office Aggregate 双写。

本任务只迁移和冻结现有语义，不实现新 Office Strategy、Leader 派发或 UI。

## 2. 当前真实入口

- 当前编译中的主记录入口仍是 `crewon_domain_processor.rs` 的 generic create/save/update/delete 与 Office RPC；`crewon_domain_office_storage.rs` 等拆分文件虽然存在，但在当前 checkout 没有挂入 `crewon_domain_processor` 的 production module tree，不能把文件存在视为已接线。
- 执行：`crewon_domain_office_run.rs`、`office_auto_dispatch.rs`、`automation_scheduler.rs`。
- 拆分文件和独立状态 inventory 仍包括 message receipt、memory index、run index、scheduler queue、automation binding、runtime owner registry、workspace identity sidecar；Stage F 必须先以编译调用图确认哪些是 production authority，不能只按文件名加 fence。
- 旧主记录位于 server-owned `<cwd>/.crewon/offices/*.json`，单文件上限 4 MiB，身份为 `workspace.recordId` + `recordRevision`。
- `crewon-state` 已提供 durable Workspace、Task、Policy/Approval、Artifact/Audit 和可重启事务模式；W3-03 不创建第二数据库。

## 3. 状态机与 Authority

`legacy(no journal) -> quiescing -> importing -> imported -> active`

- `legacy`：旧权威唯一可写。
- `quiescing`：journal 已提交，旧 mutation/dispatch 被 fence；等待活动 Run 安全 terminal/cancel/reconcile。
- `importing`：源 revision/digest 已冻结，只允许幂等导入同一规范快照。
- `imported`：规范化 legacy snapshot 已在 `state_5.sqlite` 原子提交，等待 W3-04 构造 Typed Aggregate。
- `active`：由后续 W3-04/W3-06 推进；旧链永久不可写。

回退不能删除 journal 或恢复整库。源 revision/digest、Workspace、snapshot digest 或 CAS 不匹配都返回 conflict。读取旧记录可继续用于审计，但不得成为写 authority。

## 4. Stage K State Kernel

新增 `office_migration_journals`：保存 `recordId`、server-owned `workspaceKey`、旧 revision/digest/bytes、phase、journal revision、规范 snapshot/digest、时间和 record hash。

不保存 root path、Secret、Credential、Provider body。snapshot 为 workspace-sensitive opaque JSON，Debug/错误不打印正文；大小硬上限与旧 Office record 相同。

State API：

- start/resume quiescing；
- 仅在 `quiescing` 内以 CAS 显式推进 source revision/digest，用于记录受控 cancel/reconcile 后的新 terminal 源；
- CAS 进入 importing；
- CAS 原子提交 imported snapshot；
- read journal；
- 查询 legacy write 是否已 fenced。

## 5. Importer Harness 与后续 Fence

App-server importer Harness 只读固定 Office 目录，拒绝 symlink/path escape、超限、损坏 JSON 和 revision/hash drift。规范化对象保留成员/runtime identity、Workspace binding、私有 Thread refs、shared ledger、审批/任务/产物摘要，并用真实历史 fixture 做完整 equality。它当前只挂在 `cfg(test)` 编译树：在所有旧写入/dispatch fence 落地前，不提供 production admission，避免形成可调用但不安全的半切换入口。

活动 Run 需要受控 cancel/reconcile 时，初始 journal 先建立 fence；待旧源成为 terminal 后，由 importer 在同一 Office authority lock 内重新读取并通过 CAS source advance 冻结新源，再进入 importing。不能静默接受 source drift，也不能在 `importing` 后继续推进 source。

旧主记录 write/delete、run/delegation/verification dispatch、scheduler/automation、message queue 和 sidecar mutation 都必须在各自 authority lock 内检查同一 journal fence。不能仅在 UI 或 RPC 边缘检查。

Stage F1a 先覆盖真实 v2 Office RPC 的 create/save/delete：所有操作先持有全局 Office authority lock，再解析当前不可变 record identity 并查询 State fence。缺失 `recordId` 的旧记录使用与 importer 相同的文件名摘要；没有 `threadId` 时只允许按唯一标题恢复原文件，歧义必须拒绝，不能通过生成第二个 JSON 文件绕过既有 journal。

Stage F1b 移除 production composition 中的 legacy-unfenced processor 构造：MessageProcessor 在组合根用 `StateDbHandle` 创建唯一迁移感知 processor，并以同一 `Arc` 传给启动恢复、scheduler、turn/thread listener 与 auto-dispatch。State 未初始化时使用 fail-closed processor；legacy-unfenced 构造仅在测试编译中存在。该阶段只消除依赖注入绕过，不代表 run/dispatch/sidecar 已全部检查 fence。

F1b 的 production state injection 已经 Green：production 组合路径不再构造 legacy-unfenced processor，State 不可用时不恢复旧写权。`in_process_start_without_state_db_preserves_office_migration_fence` 已证明调用方显式传入 `state_db=None` 时组合根会初始化真实 State，并继续执行 migration fence。这一结论不扩展为 F2/F3 Green。

Stage F2a 已在统一 processor 内区分 `NewWork` 与 `DrainExisting`：新 run/retry、delegation/verification prepare、auto-dispatch queue/claim 在 `quiescing` 后拒绝；cancel、terminal/failure reconcile 仅可在 `quiescing` 作为旧工作收尾，`importing` 及之后同样拒绝。输入 config 必须在 Office authority lock 内重新解析为当前持久化记录，不信任调用方的 stale snapshot。completion monitor 与 history recovery 的 terminal sync 也已改为经由同一迁移感知 processor。

F2a 不是最终运行闭环。F2b 已将 linear `OfficeDispatchPermit` 接入真实 run/delegation/verification 路径：permit 从 prepare 持有 Office authority，穿过 `turn/start`、Automation run record 等外部 start，直到 started/failed/retryable commit 消费。scheduler exact `intentId` 预阶段也已闭合：typed `OfficeAutoDispatchIntentRef` 在 live/startup 路径传递 exact identity；queue 对同一未终态 source pair 复用稳定 `intentId`；claim、mark-dispatched、mark-failed 和 clear 必须同时匹配 `intentId`、source thread/turn、lease 和 `dispatching`；requeue 不覆盖已 claim/已失败行，clear 只删除 exact row。这一阶段修复了 code review 提出的 duplicate-row、old-id、failed/requeue 和 concurrent-claim 问题。

上述进展仍不等于 F2b Green，production admission 前必须解决：

- **P0 stable dispatch authority**：live Auto Delegation 已把 stable `workspace.recordId`、scheduler exact intent/source pair、run/delegation/target、client message identity、payload hash、prompt snapshot、core turn identity 与 admitted commit绑定；exact-path reload/CAS 和 server-owned save guard阻止 stale worker或 stale client改写 receipt authority。receipt writer persistence seam 4/4 Green；locator 对 unknown durable authority fail-closed 6/6 Green（run `aad0755f-e4c0-4db3-bff0-d091f2f3e9ab`）。
- **P0 stable claim identity / `starting` recovery（targeted Green，整体仍 Red）**：production call graph已包含 exact receipt scan、Starting replay、Admitted/Failed/ExecutionUnknown sidecar reconcile，并在同一 Office authority 下重读 exact physical record。v2 admission在 flush后仍为 `NotStarted`；matching v2 `executionFence`必须再次 flush，之后才允许 task start。恢复只接受当前 runtime 精确持有的 active/terminalizing turn或 ThreadStore 中 exact client/turn identity 的 terminal turn作为 fence后 execution evidence；exact v2 admission-only/no-fence/no UserMessage-or-lifecycle evidence则只能由 Office显式 guarded resume。legacy v1、unknown/mismatched phase、persisted evidence无 fence或 fence后失去 exact active/terminal证据均写入 `executionUnknown`、清除 lease并停止 replay。该 fail-closed隔离仍不能证明外部 execution 已发生或未发生；缺少 downstream idempotency/reconcile 时不能保证 exactly-once。
- **P0b core Admission、Execution Fence 与 task-start targeted Green，Execution authority 仍为 Red**：P0b-2b 负责 default-off idle admission、durable v2 marker/fence、FIFO duplicate/hash/legacy/cross-API collision；P0b-2c 负责 exact reservation 的共享 task-start authority。顺序必须是 `admission append+flush -> executionFence append+flush -> materialize/start task`。首次新请求仍保守返回 `AdmissionOnly`，但 `executionState` 在 fence durable 后为 `Started`；只有无 UserMessage/lifecycle evidence的 exact v2 admission-only/no-fence状态返回 `NotStarted` 并允许显式 resume。UserMessage实际落盘后投影为 `Persisted`，但若缺 matching fence则为 `LegacyUnknown`，绝不能据此自动执行。上述状态都不能证明模型、工具、MCP 或远端 Agent副作用 exactly once。
- P0b-2c 在最终 active lock 内再次校验 `task.is_none()` + `Arc::ptr_eq`，先登记可取消 `RunningTask` 再打开 start gate。exact mismatch、gate receiver error或 gate 后已取消均在 deferred timing/guardian/pending/lifecycle/model 前退出；成功路径只使用 captured turn state，不读取 replacement 的全局 active turn。当前不支持 active-turn steering、thread settings override、final-output schema、Responses metadata 或 additional context。
- writer 由 default-off UnderDevelopment feature 双重检查保护，Office receipt 的 stable payload fingerprint 已由 bounded exact `promptSnapshot` 重新计算并校验，不再接受调用方自报 hash。test-only writer fault port 已覆盖七种 append/flush/load 边界；resume index 对 duplicate、unknown、wrong-thread marker 均 fail-closed。execution fence 已 durable或其 history 不可判定时，都不允许普通 replay 或 `StartIfNotStarted` 重启。production enable 前仍必须闭合 downstream model/tool/MCP idempotency/reconcile、release activation guard、真实 fsync/power-loss与NFS语义、pre-fence旧 binary部署阻断、rollout rollback/compaction、多文件 commit fault injection 与 migration竞态。
- **P0 single-writer lease + handoff（targeted Green，release gate仍 Red）**：per-thread OS lease 以 canonical `codex_home + ThreadId` 为 identity，覆盖 recorder create/resume 到 flush/shutdown/discard 的完整生命周期，并覆盖 cold metadata marker、compression、archive/unarchive/delete。新 owner 获取 lease 后重读完整 durable `RolloutItem` 流；thread id mismatch、parse error、stale或同长度语义变化均 fail-closed，WouldBlock 映射为 Conflict。双 LocalThreadStore Harness、真实双 app-server resume/append/graceful handoff、异常退出 lease 释放、ThreadStore conflict 映射与 `crewon-app-server` full suite 1252/1252（run `1c9096c2-160c-4fec-a33e-1f1bab7d5fa4`）均已 Green。generation lock 的 shared/exclusive OS语义、canonical-home identity、跨进程竞争与kill释放已6/6 Green，默认和legacy feature的编译模式也各2/2 Green。该 substrate 只证明 fence-aware generation之间互斥；不读取generation lock的pre-fence binary仍可写。F2b-3d6c必须分四阶段闭合：Stage A覆盖所有rollout marker/file mutation边界；Stage B覆盖ThreadStore SQLite-only mutation与archive/unarchive/delete rename边界；Stage C在legacy artifact编译配置中force-off所有不允许的writer/feature入口；Stage D生成immutable Legacy Fence/Cutover artifact及manifest，并在真实production launcher/container exec前强制SHA allowlist。当前A/B正在实现，C/D未闭合；standalone verifier的10/10只证明校验器行为，且`productionWiring:notConnected`，不能作为部署保护。真实 power-loss/fsync 与 NFS/非本地文件系统锁语义仍未验证。
- **P0 `executionUnknown` reconcile（设计完成，实现 Red）**：拟议 v2 `office/delegation/reconcile` 必须绑定 server-owned canonical Office/delegation identity/receipt 并使用 CAS，不接受 client config、filePath 或 turnId，只检查 scheduler、runtime ownership 和 ThreadStore terminal evidence，绝不启动 turn。只有 exact evidence 才可转为 attached/completed/failed/interrupted；证据不足返回 stillUnknown 并保持 quarantine。failed/interrupted 后才能进入既有显式 retry，“重新检查”本身不得执行。
- **P0 migration-owned reconcile**：`DrainExisting` 只能由迁移协调器授权，且必须绑定已存在的 run/turn/dispatch identity。terminal/cancel/reconcile 后必须在同一 authority 边界完成 source digest/revision 重读与 journal CAS advance；普通 listener/scheduler 不能把 drain 变成新 queue、retry 或 replan。
- **P1 runtime repair**：scheduler recovery 和 verification preload 必须先获得对应 Office 的 stable claim/receipt/permit，再创建 replacement Thread、更新 Agent/Automation 或回写 runtime binding。existing-member startup、empty-member runtime repair 与 missing-Automation runtime repair Harness 均已 isolated 连续 3 次 Green；auto-replan Harness 在 fixture 补入 pending scheduler intent 后也已 isolated 连续 3 次 Green。兼容性修复后、上述 Harness 最终改动前的完整 suite 共 1187 项：1181 passed、3 failed、3 timeout；唯一 Office failure 是旧 auto-replan Harness，已由后续 isolated 3/3 修复验证，其余为既有 thread/remote/session 资源时序。因尚无最终 Harness 改动后的 full-suite 结果，F2d 仍不记为闭合 Green。
- **P1 corrupt legacy quarantine、memory identity 与 sidecar bounds**：production 读取仍缺 strict corrupt legacy file quarantine；test-only importer 拒绝 corrupt source 不等于 production quarantine 已闭合。memory authority 必须统一使用 `workspace.recordId`，不得继续依赖 top-level `id`、threadId 或 title slug fallback。memory index、run index、scheduler queue 及其他迁移 inventory 的读写都必须有 byte/item 硬上限、原子写和 corrupt fail-closed 语义，并由 per-record fence 覆盖。

## 6. Harness 与验收

- 相同 start/transition/commit 重放无重复副作用；不同源或 snapshot conflict。
- journal 在关闭/重开后保持 fence；CAS 和持久化 hash 被篡改时 fail-closed。
- Workspace 不存在、超限 snapshot、非法 JSON 被拒绝。
- 后续 fixture 覆盖 idle、running、partial failure、pending approval、completed、corrupt；每个 crash point 可安全重跑。
- 所有旧写入和 dispatch 入口都有 fence 清单与测试证据。
- Harness 必须证明 `quiescing` 可收尾但不会 queue/claim/start 新工作，`importing` 及之后不会再改写任何 legacy record/sidecar。
- Harness 必须以模型请求数、文件精确 bytes、lease/dispatch 字段和 sidecar 目录集合作为主证据，不仅依赖“未观察到通知”。writer ack 故障还必须区分 definitively-not-written 与 durable-but-ack-failed；fence 已 durable 的歧义必须断言模型请求为零且后续不重放。
- scheduler exact-intent Harness 已覆盖 9/9，sync/delegation/replan focused Harness 各 1/1 Green；protocol/core/Office targeted Harness已分别证明 v2 phase wire contract、admission/fence/task顺序、exact v2 admission-no-fence显式恢复、legacy v1与gate-off fail-closed，test-only writer fault 为 7/7 Green，resume index 为 13/13 Green。local rollout writer lease已有真实子进程竞争、双 store handoff、真实双 app-server graceful handoff、异常退出释放及 package suites证据；generation lock matrix与两种编译mode也有targeted Green。上述证据仍不替代 external-start exactly-once或production deployment fence证明；Stage A/B marker mutation fence、Stage C feature force-off、Stage D immutable artifact/launcher/container SHA wiring、真实 fsync/power-loss、NFS/非本地锁语义、`starting` crash window与迁移竞态仍须闭合。
- startup Harness 必须分开记录 isolated repeat 与 full-suite 结果；当前三个 startup/runtime-repair Harness 与修复后的 auto-replan Harness 均为 isolated 3/3 Green，但不得把它们表述为最终改动后的 full-suite Green。

## 7. 非目标与停止条件

- 不实现 W3-04 Typed Aggregate、W3-05 Strategy/Leader、W3-06 UI cutover。
- 不双写 JSON/sidecar 和新 Aggregate。
- 活动 Run 无法安全 quiesce 时保持 fenced 并记录可审计阻断，不复制内存态、不强行推进 imported。
- 任一旧写入口无法证明受 fence 保护时，不能把 Office 标记为 active。
- stable receipt/identity、exactly-once 外部副作用、runtime repair、strict corrupt quarantine 或 sidecar bounds 任一仍为 Red 时，不能开启 production importer，也不能把 W3-03 交给 W3-04 作为已完成前置。
