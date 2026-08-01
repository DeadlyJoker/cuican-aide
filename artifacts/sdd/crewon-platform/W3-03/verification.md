# W3-03 Verification

状态：Stage K、Stage I1、Stage I2a、Stage F1a 与 Stage F1b Green，其中 F1b production state injection 和 `state_db=None` in-process migration fence Harness 已闭合。Stage F2a 已完成首轮运行 fence 接线；F2b 已有 linear `OfficeDispatchPermit`、scheduler exact `intentId`、P0b durable marker/resume index、default-off idle admission、reservation-aware task start、effective-cwd precondition与 v2 Durable Execution Fence targeted Green。writer fault 已扩为 7/7、resume index 13/13、latest Office durable 9/9。local rollout single-writer/handoff、真实双app-server graceful handoff、异常退出lease释放与conflict mapping均已Green。generation lock substrate新增targeted Green：matrix 6/6（run `435432c6-bd5e-4dc1-8113-ca4f430d90c3`）、rollout 84/84（run `542733ca-066a-4c2c-aa53-7939373800f1`）、app-server default generation 2/2（run `bd8a7a23-2b30-4743-a1e7-cf80128f39f0`）、legacy feature generation 2/2（run `a1b67eea-3d17-4f04-9cdd-ffa839fac47c`）。F2b-3d6c Stage A-C已闭合；Stage D build/probe substrate已实现，但clean-tree真实release、三个Legacy相关真实release conflict probe、production binary/container authority与atomic launcher/container wiring尚未闭合。deployment verifier标准库Harness 10/10 Green，但`productionWiring:notConnected`，不能关闭SHA Gate。不启动turn的`executionUnknown` reconcile、downstream model/tool/MCP idempotency/reconcile、真实power-loss/fsync与NFS语义、其余多文件故障矩阵、migration竞态、migration-owned reconcile、Office storage authority cutover、strict corrupt legacy quarantine和storage/memory sidecar边界尚未Green；Importer production admission与durable Office feature继续disabled，整体Gate仍Red/default-off。

本轮最终增量（取代本文后续仍保留的中间 3/3 与 `669bf807-...` 记录）：writer fault Harness 已扩为 7/7 Green（run `11def95f-63ba-4b8a-bc0d-d83f383c5154`），resume index 13/13 Green（run `506976a8-a4a7-4efa-a718-a9d764f9261b`），最新 Office durable combined 9/9 Green（run `d88fd93d-a716-4a96-b4f8-0064bc35c39b`）。新增边界包括 admission/fence append reject、flush 后 exact/absent/unknown、history load failure，以及 duplicate/unknown/wrong-thread marker poison；只有 exact admission/no fence 可 guarded resume，fence exact/unknown 均零模型请求并 fail-closed。

single-writer 最终增量（取代本文后续“只完成设计/未实现”的历史记录）：local rollout 已使用 canonical `codex_home + ThreadId` 的 per-thread OS lease。lease 覆盖 recorder create/resume 到 flush/shutdown/discard，并覆盖 cold metadata marker、compression、archive/unarchive/delete；resume 在 lease 内重读完整 durable history，拒绝 thread-id mismatch、parse error、stale history及同长度语义变化。历史基线`crewon-rollout` 77/77（run `98074dc8-657e-455a-a0ef-1dac15d25277`）、`crewon-thread-store` 92/92（run `c02a583c-d8de-4a37-974d-5ca320f5c708`）、真实双app-server handoff、异常退出lease释放、core conflict映射与`crewon-app-server` 1252/1252（run `1c9096c2-160c-4fec-a33e-1f1bab7d5fa4`）均Green。generation lock加入后的最新`crewon-rollout`为84/84 Green（run `542733ca-066a-4c2c-aa53-7939373800f1`），其中generation matrix 6/6 Green（run `435432c6-bd5e-4dc1-8113-ca4f430d90c3`）。F2b-3d6c Stage A-C已闭合；仍未闭合的是Stage D clean-tree真实release、三个Legacy相关真实release conflict probe、production artifact authority/atomic launcher阻断、真实power-loss/fsync与NFS/非本地文件系统锁语义，以及最终core/workspace full suite；overall Gate继续Red/default-off。

## Discovery

- 当前真实编译路径的 Office 主 record 写入仍在 `crewon_domain_processor.rs` 的 generic create/save/update/delete；`crewon_domain_office_storage.rs` 及相关拆分文件存在于源码树，但当前没有挂入 production module tree，不能当成已生效 authority。
- scheduler、memory、receipt、run index、automation binding、runtime owner 和 workspace identity 文件仍需保留在 Stage F inventory；是否属于生产写入口必须用编译调用图和测试确认，不能仅凭文件存在判断。
- `crewon_domain_office_run.rs` 约 7,854 行，不能继续承载迁移领域逻辑；W3-03 使用新模块并只在热点加入最小 fence。
- `state_5.sqlite` 当前 migration 到 0053；0054 可作为 Office migration journal，不需要新数据库或依赖。
- 当前生产 Office 仍是旧 JSON/sidecar authority；没有 W3-03 journal/fence，因此 Gate 初始为 Red。

## Stage K 实现

- 新增 `0054_office_migration_journal.sql`，phase 为 `quiescing -> importing -> imported -> active`，Workspace 使用现有 durable root 外键；source/snapshot/record hash、bytes、时间和 CAS revision 均有数据库与 Rust 双层约束。
- 新增独立 `office_migration_records.rs` 与 `runtime/office_migration.rs`，没有进入 `crewon-core`，也没有扩展 7,854 行 Office Run 模块。
- 相同 start/transition/commit 幂等；source revision/digest、Workspace、CAS 或 snapshot 改变均 conflict。
- 相同 source 的 restart 不再绑定新的观察时间；原始 `startedAt` 保持不变。受控 quiesce 产生的新 terminal source 只能在 `quiescing` 内通过 source digest + journal revision 双 CAS 推进，stale replay 或后续 phase 均 conflict。
- `office_legacy_write_status` 在 journal 存在后返回 fenced；关闭/重开后状态保持。
- snapshot 正文只作为 workspace-sensitive opaque JSON 存储，`Debug` 输出统一脱敏；非法 JSON、非 object、digest mismatch 和 4 MiB 超限 fail-closed。

## Stage I1 Harness

- 新增独立 Office legacy snapshot Harness，并显式挂到真实 `crewon-app-server` 测试编译树；当前先以 `cfg(test)` 作为 importer 的 executable specification，避免在 production 尚无 admission/fence 时留下未使用或可误调用的半成品入口。
- fixture 使用真实 `PersistedDomainConfigRecord` envelope，覆盖 idle、completed/failed、pending approval、shared ledger、artifact、running manager、active child dispatch、缺失 legacy identity、corrupt/unknown 和 source/snapshot bounds。
- 原始文件摘要绑定精确 bytes，因此 key 顺序变化会产生不同 source digest；规范化 snapshot 递归排序 object key，语义相同记录得到相同 snapshot JSON/digest。
- 缺失 `recordId/recordRevision` 使用与现有 strict discovery 一致的 `legacy-sha256` 规则确定性补齐；规范 snapshot 保留 config 全对象、成员/Thread refs、审批、任务、产物和 shared ledger，不保存文件路径。
- 活动 manager 或 active child dispatch 返回结构化 blocking observation；损坏或无法识别的活动 Run fail-closed，不伪造 terminal。
- Debug 不输出 source/snapshot 正文。

## Stage I2a Executable Harness

- 新增独立 `OfficeLegacyImporter` test-only executable specification；它持有真实 Office authority lock，依赖 `crewon-state` journal，不修改生产 RPC/dispatch 行为。
- strict source reader 只接受 server-owned absolute `<cwd>/.crewon/offices/*.json`，拒绝 parent escape、目录/文件 symlink、非 regular/空/超 4 MiB 文件，并在 Unix 上校验 open/current inode 与 device 一致。
- import 流程为 `read exact source -> start/resume journal -> quiesce gate -> begin importing -> re-read exact source -> atomic commit`；journal 后和 begin import 后两个 crash point 都可向前恢复。
- active/unknown Run 返回结构化 `Quiescing`，不会导入内存态；旧链完成受控终止后必须显式调用 CAS source advance，再执行 import。
- imported/active replay 必须同时匹配 source 与 normalized snapshot；任何无 advance 的 source drift fail-closed。

## Stage F1a RPC Main Record Fence

- `OfficeLegacyRecordMutator` 成为 v2 Office RPC create/save/delete 的唯一主记录 mutation 入口；MessageProcessor 注入启动时真实 `StateDbHandle`，且 auto-dispatch context 复用同一 processor clone。
- mutation 顺序固定为 `Office authority lock -> resolve current record identity -> State write-status -> write/delete`。State 读取失败和 journal hash 异常 fail-closed；已 fenced 时返回稳定 `officeMigrationFenced` error data，包含 phase 和 journal revision，不暴露 snapshot/path。
- create 必须已有 server-assigned `recordId`；save 禁止改变现有 record identity。显式 ID 必须解析到现有记录，不能借新 ID 写出副本。
- id-less legacy save 使用与 importer 相同的 `legacy-{sha256(fileName)}` identity。无 `threadId` 时在 authority lock 内按唯一标题恢复原文件；多个候选返回歧义错误，不能通过时间戳文件名复制出第二条未 fenced 记录。
- production importer admission 继续关闭，直到 F2/F3 证明 run、dispatch、scheduler、automation 与 sidecar authority mutation 均受同一 fence 保护。

## Stage F1b Production Composition

- `MessageProcessor` 在组合根用真实 `StateDbHandle` 创建唯一迁移感知 `CrewonDomainRequestProcessor`，并以同一 `Arc` 交给启动恢复、`AutomationScheduler`、`TurnRequestProcessor`、Thread listener 与 `OfficeAutoDispatchContext`。
- production source 中不存在 `CrewonDomainRequestProcessor::new()`；legacy-unfenced constructor 仅在 `cfg(test)` 下编译。
- State handle 不存在或 fence 查询失败时使用 `migration_unavailable` 并 fail-closed，不能因本地状态初始化失败而恢复旧 Office 写权限。
- `in_process_start_without_state_db_preserves_office_migration_fence` 已 Green：即使 in-process caller 显式传入 `state_db=None`，组合根也会初始化真实 State handle，后续 Office mutation 仍被 migration journal fence 拒绝。
- F1b 只封堵 processor 构造和主 record mutation 的依赖注入绕过；run/message/delegation/verification/scheduler/automation/sidecar 的实际 claim 与 mutation fence 仍属于 F2/F3，因此整体 Gate 仍为 Red。

## Stage F2a Initial Runtime Fence Wiring

- `OfficeLegacyRecordMutator` 已区分 `NewWork` 与 `DrainExisting`。`quiescing` 拒绝新 run/retry、delegation/verification prepare、auto-dispatch queue/claim，但允许已存在工作的 cancel、terminal/failure reconcile；`importing` 及后续 phase 对两类都 fail-closed。
- run/delegation/verification 入口不再直接信任调用方 config；在 Office authority lock 内解析当前持久化 record identity 与 config，再执行 fence 和领域 mutation。
- auto-dispatch 通过 source thread/turn 有界扫描关联 Office，queue/claim/prepare 走 `NewWork`，dispatched/failed/clear 走 `DrainExisting`。
- completion monitor 与 startup/history recovery 的 terminal sync 已改为调用同一迁移感知 processor，不再从组合路径直接调用自由 sync 函数。
- 以上只是 F2a 的实现进度记录，尚未形成可开启 importer admission 的完整证据链，不将 F2 标记为 Green。

## Stage F2b Partial Dispatch Authority

- production message 与 auto-dispatch 路径已使用 linear `OfficeDispatchPermit`：permit 在 prepare 时持有 Office authority，穿过 Run/Delegation/Verification 的 `turn/start`、Automation run record 等外部 start，并在 started/failed/retryable commit 处消费。
- scheduler exact `intentId` 预阶段已完成：typed `OfficeAutoDispatchIntentRef` 在 live/startup 路径传递 exact identity，queue 对同一未终态 source pair 稳定复用 `intentId`；claim、mark-dispatched、mark-failed 与 clear 必须同时匹配 `intentId`、source thread/turn、`dispatching` 状态和当前 lease。requeue 不覆盖已 claim/已失败行，clear 只删除 exact row。
- code review 中的 duplicate-row、old-id、failed/requeue 和 concurrent-claim findings 已修复；scheduler 9/9 Green，sync/delegation/replan focused Harness 各 1/1 Green。
- scheduler exact-intent/queue-CAS 本身不是 external-start exactly-once 证明；v2 execution fence只把“durable admission但尚未允许task start”与“已越过task-start边界”分开。exact v2 admission-only/no-fence/no UserMessage-or-lifecycle evidence可显式恢复；v1/unknown phase、persisted-without-fence与 fenced-without-exact-active-or-terminal均隔离。fence不是下游副作用 receipt；test-only writer ack fault、local rollout single-writer、真实双 app-server graceful handoff与异常退出lease释放已 targeted Green，但真实 local writer power-loss/fsync与NFS语义、pre-fence artifact deployment guard、downstream idempotency/reconcile、多文件故障和 migration竞态仍未闭合。

## Remaining P0/P1 Findings

### P0: Durable Restart/Reclaim Targeted Green; Overall Exactly-Once Gate Still Red

- Auto Delegation live path 已把 stable `workspace.recordId`、scheduler exact intent/source pair、run/delegation/target、bounded prompt snapshot、client identity、payload hash、core turn与 admitted commit绑定；gate-on Harness断言同一 delegated task模型请求恰好一次。
- Starting recovery按 exact physical file path在 authority内重读并执行完整 receipt Eq CAS，Admitted/Failed scheduler reconcile也在同一 authority下重新验证 canonical receipt；generic `office/save`不能注入、删除、篡改或回退 server-owned durable state。receipt writer seam 4/4、locator unknown-authority fail-closed 6/6（run `aad0755f-e4c0-4db3-bff0-d091f2f3e9ab`）均 Green。
- current-runtime ownership 通过引用计数 guard 保留 exact turn identity，直到 TurnComplete/TurnAborted terminal event 持久化完成；active attach Harness 用请求进入 oneshot + 响应 gate 保持 exact turn 活跃，收紧 responder失败路径后 1/1 Green（`65ec5222-27ef-4813-bc8b-415dbe76a110`）。Office `executionUnknown` 已提交而 scheduler 尚为 expired `dispatching` 的单边故障收敛 Harness在收紧 recovery server总请求为零与同步二次 `office/read` drain后 1/1 Green（`d373182c-4927-496e-8b66-fa9cfd5bfc97`）。receipt/scheduler reducer 3/3 Green（`79487d0f-6d1d-41b3-8e92-0fa586ad8ce0`）。此前统一 `office_auto_dispatch_durable_ --retries 0` 连续两次8/8 runs `91352417-cfd5-4296-859e-c1e3daf81f0a`、`5483dc08-ac1b-4e77-aca2-3d0272b26821` 早于v2 execution fence最终改动，只作历史基线。
- v2 admission只证明 admission durable；matching v2 `executionFence`只证明系统已允许task start，二者都不是external execution receipt。恢复矩阵为：exact v2 AdmissionOnly + no fence + no matching UserMessage/lifecycle evidence可由 Office显式 guarded resume；legacy v1、unknown/mismatched phase、UserMessage/lifecycle persisted但无 fence、或有 fence但无 exact current-runtime active/terminalizing及 persisted terminal证据均持久化 `executionUnknown` 并停止自动 replay。test-only writer fault Harness 已证明 fence durable但 ack 失败时不发起模型请求；local rollout lease、真实双 app-server handoff与异常退出释放已封闭合作版本间的并发 writer/handoff TOCTOU，app-server full suite也已 Green。该矩阵仍不是 durable execution authority；真实 power-loss/fsync与NFS语义、pre-fence artifact两阶段围栏及deployment allowlist、其余 receipt/rollout/scheduler commit fault matrix、rollout rollback/compaction、migration竞态、storage/memory边界或最终 core/workspace full suite仍未覆盖，因此 F2b-3d3、F2/F3 与 overall Gate仍 Red，durable feature继续 default-off。

### P0b: Admission/Execution-Fence/Task-start Targeted Green; External Execution Authority Red

- `UserInputOnceMarker` 与 bounded resume index 已落地；v2 wire contract显式区分 `admission` 与 `executionFence`，两类 marker都不进入模型上下文。v1、unknown phase、foreign/fork collision、mismatched/out-of-order fence和bounded overflow均 fail-closed。
- P0b-2b 与普通 submission 共用单一 FIFO consumer。default-off feature 同时在 enqueue 和 process 端检查；仅在 idle 时按 `admission append+flush -> executionFence append+flush -> task start` 执行，active turn、thread settings override、final-output schema、Responses metadata 和 additional context 明确拒绝。
- marker append 前先写 live index quarantine；append/metadata/flush 结果不确定时同进程 retry 不会重复写 receipt。writer fault Harness 进一步区分：admission append 明确未写可同 identity 重试一次；admission 已写但 flush ack 失败只 guarded resume 原 turn；fence 已写但 ack 失败返回 `ExecutionStartLost` 并 fail-closed。feature 开启时普通 UserInput 的合法 client ID 会在副作用前原子 reserve Legacy，regular/once 双向 collision fail-closed。
- P0b-2b + P0b-2c 首次请求在 admission与execution fence均 durable 后通过 exact reservation启动任务；并发同 identity只发出一个模型请求，另一路返回同一 AdmissionOnly receipt；同 ID不同 hash conflict；regular duplicate不产生第二请求。ordinary lookup不会启动 admission-only identity；只有 Office显式传 `StartIfNotStarted`且index判定 exact v2/NotStarted时才恢复原 turn一次。
- P0b-2d 对新 admission 使用显式 `TurnContextPrecondition`：同一 SessionConfiguration + resolved environments 快照决定 effective cwd 与后续 TurnContext；mismatch 在 marker 前拒绝且不消费 identity；已有 receipt 在 resume cwd 改变后仍 exact replay。
- 本轮完整 `user_input_once` filter 共 22 项，Nextest run `cae240b6-9bf0-4f42-b635-16ffb489623d`：17 passed，5 项为既有 10s event timeout，因此不记为完整 Green。matching-turn exact 用例精确重跑 1/1 Green（run `1a42fa6b-828d-47c3-93ea-af20bf224b0b`）；concurrent exact 重跑仍为 10s timeout（run `d9f170c3-4291-4f10-84da-dd3d39767288`），保留为既有测试时序问题，不写成功能回归。writer fault 三个精确 Harness 为 3/3 Green（run `f99fa00c-9ff1-4fb5-b821-36255eef6399`）。更早的 18/18 run `ef2974c3-b03c-41f6-9899-e04a0787a044` 与 concurrent 1/1 run `5c26fd4e-948b-406b-9fbd-31325c5ea5f6` 只保留为历史基线，不覆盖本轮新 writer fault Harness。
- Office identity/receipt/recovery contract 已进入 production 编译树：identity 4/4、receipt 7/7、recovery locator/scan/prepare/reload 19 项 targeted coverage、server-owned generic-save guard 7/7 Green。gate-on live Harness证明真实 Auto Delegation写入 `admitted/admissionOnly` receipt、scheduler `dispatched`且 exact delegated模型请求为一；后续 restart/reclaim/downgrade Harness补充了跨进程 targeted 证据，但仍不是 power-loss/migration/full-suite 的整体 exactly-once 证明。

### P0: Reconcile Must Be Migration-Owned

- `DrainExisting` 在 `quiescing` 中是必要的收尾能力，但它必须由 migration coordinator 对 journal 中已存在的 active identity 显式授权，不能成为普通 listener/scheduler 的宽泛写权。
- terminal sync 底层仍会隐式执行 scheduler enqueue，导致“收尾”路径可以产生新 delegation/verification/replan intent；必须把 reconcile 和 enqueue 彻底拆开。
- 受控 terminal/cancel/reconcile 改变 legacy source 后，必须在同一 Office authority 边界重读精确 bytes/revision/digest，再以 journal revision + old digest 双 CAS 调用 source advance；当前生产路径尚未完成这个闭环。

### P0: Generation Substrate Green; Marker Mutation and Production Release Fence Still Red

- 当前 local rollout 已使用 per-thread 跨进程独占 lease，从 writer open 持有到 flush/close/discard；旧 owner 释放后，新 owner获取 lease并在 lease 内重读 durable history。WouldBlock fail-fast，history、thread id或parse authority不一致均不打开可写会话。真实子进程锁竞争、双 LocalThreadStore handoff、stale/same-length/malformed history、真实双 app-server resume/append/graceful handoff、异常退出释放及 scoped package suites已 Green。
- generation lock substrate以canonical home下同一OS lock实现`LegacyFenceExclusive`与`LeaseAwareShared`，覆盖同进程/跨进程共享排他、symlink alias和kill释放；6/6与rollout 84/84 Green。app-server默认artifact选择shared mode 2/2 Green，`legacy-fence-artifact` feature选择exclusive mode 2/2 Green。该结论只适用于已经获取generation guard的fence-aware进程。
- F2b-3d6c Stage A-C已完成：rollout Legacy Fence default 89/89、feature 94/94；ThreadStore default 93/93（run `ff987062-9429-4aba-8381-6e270c53b8e4`）、feature 99/99（run `9884e69c-34cb-499e-8f2f-797b1475b288`）；legacy feature force-off targeted 1/1（run `3d963730-7214-4348-8569-751c80bb3fe7`）；真实 startup Harness default 4/4（run `8bd5c99c-69f6-4f2d-9d01-6e56b42be892`）、legacy 3/3（run `28d1b00d-f32a-4768-9e2a-390544aadb75`）。Stage D build/probe substrate已实现但production仍Red：builder默认clean tree、使用`codex-rs` pinned toolchain与`--frozen`、两套隔离target dir、构建前后`Cargo.lock` SHA、临时stage与atomic publish，并为两个generation分别产生manifest/allowlist。probe必须从真实binary行为验证exact四case，builder再校验case/result/distinct ports及artifact path/SHA/size identity。当前dirty tree未构建真实release，三个Legacy相关真实release conflict probe未跑；standalone verifier和build receipt都明确`productionWiring:notConnected`，且Python verify后path exec仍有TOCTOU，不能替代真实atomic launcher/container authority。
- 兼容性边界：pre-fence旧binary不读取generation lock，任何只由新binary检查的advisory lock都无法阻止它写入。只有production launcher/container拒绝其artifact SHA才能封闭该边界；当前没有可靠immutable app-server artifact authority，因此SHA Gate仍Red。
- 进程 kill 后 lease 释放已经 targeted Green，但真实断电时 durable bytes、fsync边界，以及 NFS/非本地文件系统的锁与rename语义仍未验证。
- 拟议的 v2 `office/delegation/reconcile` 是 server-owned exact identity/CAS 读模型，请求不接受 client config、filePath 或 turnId，只由 canonical Office/delegation identity 查找 receipt、scheduler、runtime ownership 与 ThreadStore terminal evidence，不启动 turn。结果只能是 attached/completed/failed/interrupted/stillUnknown；没有 exact evidence 就继续 quarantine。这是设计结论，不是已实现 API 或 UI。

### P1: Runtime Repair Isolated Harnesses Green, Authority Order Still Open

- existing-member startup delegation recovery、empty-member runtime repair 与 missing-Automation runtime repair 三个精确 Harness 均已 isolated 连续 3 次 Green。
- auto-replan startup Harness 在 fixture 补入 pending scheduler intent 后已 isolated 连续 3 次 Green，修复了 full suite 中旧 fixture 无法触发 scheduler recovery 的 Office failure。
- 兼容性修复后、上述 Harness 最终改动前的完整 `crewon-app-server` suite 共 1187 项：1181 passed、3 failed、3 timeout。唯一 Office failure 是旧 auto-replan Harness；其后续修复已有 isolated 3/3 证据。其余失败/超时来自既有 thread、remote、session 资源时序，不归因于本次 Office 改动。该完整 suite 发生在最终 Harness 改动前，因此不能记作最终状态 full-suite Green。
- 需要收敛为 per-record/source-turn `stable claim/receipt/permit -> load/repair -> prepare -> start -> commit`，不能以 cwd 为粗粒度全局停机；同工作区的未迁移 Office 和独立 Automation 必须继续可用。

### P1: Memory Identity and Sidecar Bounds Are Incomplete

- production legacy discovery/read 尚未实现 strict corrupt file quarantine。test-only importer 对 corrupt source 的拒绝是 executable specification，不能当成 production quarantine 证据。
- Office memory 当前 identity 仍可从 top-level `id`、workspace threadId 或 title slug 回退，与 migration journal 的 `workspace.recordId` authority 不一致，存在重命名、Thread repair 或 legacy fallback 导致跨 Office 错配的风险。
- memory index 有 item count 上限，但读取缺少 byte 硬上限；run index 和 scheduler queue 也使用无界 `fs::read`/JSON parse fallback。不能把 corrupt/超限文件静默当空状态后继续写入。
- F3 必须对 message receipt、memory index、run index、scheduler queue、automation binding、runtime owner registry 和 workspace identity sidecar 建立可执行 inventory，逐项证明 hard bounds、atomic replace、corrupt fail-closed、per-record fence 和 import snapshot 归属。

## Code Review 结论与 Wave 顺序

- change-size review：不将整个 W3-03 或 permit + scheduler + recovery + sidecar 当成一个可合并单元。scheduler exact `intentId`、P0b-2b durable receipt 与 P0b-2c reservation-aware start 均为独立 stacked slice；后两者 churn 分别为 442 与 314，均低于 `<=500` 限制。Office stable receipt/external exactly-once 继续独立落地。
- testing review：scheduler exact intent 9/9、sync/delegation/replan focused Harness 各 1/1、permit fence 6/6、delegation 9/9、verification 2/2、receipt writer seam 4/4、locator unknown-authority fail-closed 6/6、latest combined durable 9/9、writer fault 7/7、resume index 13/13、local rollout single-writer、真实双app-server graceful handoff、异常退出lease释放、core conflict mapping、generation lock、Stage A/B marker mutation fence、Stage C feature force-off、两种app-server generation startup Harness与app-server 1252/1252 full suite均已Green。Stage D三个Python unittest文件合计39/39 Green且`py_compile`通过；覆盖Git快照并发变化、原子no-clobber竞态、子进程timeout/进程组回收、Secret环境隔离、已有文件内容篡改与特殊/超限条目fail-closed。`--allow-dirty --dry-run`确认Rust 1.95.0、`aarch64-apple-darwin`、`codex-rs` cwd及两条frozen release命令，默认权威构建在dirty tree下按预期拒绝。这些是substrate evidence，不是production release证据。完整core `user_input_once`本轮为17 passed/5 existing 10s timeout，不得记为22/22 Green。仍需clean-tree真实artifact/probe、production atomic launcher/container authority、external side-effect receipt、真实power-loss/fsync与NFS语义、migration-vs-start、多文件persistence fault injection与最终core/workspace full-suite证明。
- 后续严格顺序：Stage D clean-tree双artifact build + exact四case真实probe -> production authority/platform决策 -> atomic launcher/container SHA wiring -> 不启动turn的`office/delegation/reconcile` -> downstream execution authority/idempotency -> F2c migration-owned reconcile/source CAS -> F2d runtime repair稳定Green -> F3 corrupt quarantine/memory/sidecar -> I2b production importer admission -> W3-04。

## 验证命令

1. `just test -p crewon-state office_migration`
   - 5 passed，234 skipped。
   - 覆盖 restart、concurrent duplicate、source drift、quiescing source CAS advance、Workspace dependency、tamper、snapshot validation、Debug redaction 和 changed replay。
2. `just test -p crewon-state`
   - 239 passed，0 skipped。
3. `just test -p crewon-app-server office_migration_snapshot`
   - 5 passed，1166 skipped。
   - 覆盖规范化 equality、语义保留、quiesce blocking、legacy identity、Debug redaction 与 fail-closed bounds/corrupt 数据。
4. `just test -p crewon-app-server office_migration_importer`
   - 4 passed，1173 skipped。
   - 覆盖 idle import/restart、journal/begin crash recovery、active Run 显式 source advance，以及 corrupt/outside/symlink source rejection。
5. `just test -p crewon-app-server`（F1a 后基线）
   - 1180 passed，1 skipped；3 个既有时序用例首次波动后由测试框架 retry Green。
   - Office domain、migration snapshot/importer 与 state-backed platform tests 均 Green；flaky 事实保留在测试输出中，不把它误记为本切片确定性失败。
6. `just test -p crewon-app-server office_legacy_record_mutation`
   - 3 passed，1178 skipped。
   - 覆盖 fenced create/save/delete、文件内容不变，以及无 recordId/threadId 的 legacy save 不得复制新文件绕过 journal。
7. `just test -p crewon-app-server v2_office_save_and_delete_fail_closed_after_migration_journal_starts`
   - 1 passed，1180 skipped。
   - 通过真实 v2 app-server 证明 MessageProcessor 与外部写入 journal 共享同一 `state_5.sqlite` authority，save/delete 均返回 typed fence error 且原文件不变。
8. `just test -p crewon-app-server office_startup`
   - 4 passed，1177 skipped。
   - 证明启动恢复复用组合根 processor，并保持既有 Office startup recovery 行为。
9. `just test -p crewon-app-server`（F1b 后）
   - 1179 passed，1 failed，1 skipped；5 个既有时序用例 retry Green。
   - 唯一失败为 websocket transport 的第二次 Ctrl-C 退出时序测试，与 Office/State 路径无关；随后执行 `just test -p crewon-app-server websocket_transport_second_ctrl_c_forces_exit_while_turn_running`，1 passed、1180 skipped。记录为非 Office 的隔离时序波动，不将全量命令误记为 Green。
10. F2b targeted filters
   - scheduler exact intent：9/9 Green。
   - scheduler sync、delegation 和 replan focused Harness：各 1/1 Green。
   - permit fence/legacy mutation：6/6 Green。
   - delegation：9/9 Green；verification：2/2 Green。
   - 实时 auto delegation 与 auto replan 精确 integration tests Green。
11. `just test -p crewon-app-server in_process_start_without_state_db_preserves_office_migration_fence`
   - Green。
   - 证明 in-process `state_db=None` 不会绕过 production migration fence。
12. startup recovery/runtime repair Harness isolated repeats
   - existing-member delegation recovery：3/3 Green。
   - empty-member runtime repair：3/3 Green。
   - missing-Automation runtime repair：3/3 Green。
   - auto-replan startup recovery 在 fixture 补入 pending scheduler intent 后：3/3 Green。
13. `just test -p crewon-app-server`（兼容性修复后、Harness 最终改动前）
   - 共 1187 项：1181 passed、3 failed、3 timeout。
   - 唯一 Office failure 为旧 auto-replan Harness；该 fixture 后续补入 pending intent，并由 isolated 3/3 Green 验证修复。
   - 其余失败/超时为既有 thread、remote、session 资源时序。由于该命令早于最终 Harness 改动，不将其记为最终 full-suite Green，也不将后续 isolated 结果改写成已完成 full-suite 验证。
14. P0b core durable receipt + reservation-aware start + writer fault Harness
   - protocol phase/schema targeted test Green，Nextest run `100b43a6-6bdc-495d-a774-77f22ec4cd85`；v2 wire value明确为 `admission` / `executionFence`，legacy缺省仍只作为兼容读取，unknown phase不升级为可恢复状态。
   - `just test -p crewon-core user_input_once --test-threads=1`：22 项中 17 passed、5 项既有 10s event timeout，Nextest run `cae240b6-9bf0-4f42-b635-16ffb489623d`，不记为完整 Green。matching-turn exact 重跑 1/1 Green，run `1a42fa6b-828d-47c3-93ea-af20bf224b0b`；concurrent exact 重跑仍 timeout，run `d9f170c3-4291-4f10-84da-dd3d39767288`。
   - `just test -p crewon-core user_input_once_writer_faults --retries 0 --test-threads=1`：7/7 Green，Nextest run `11def95f-63ba-4b8a-bc0d-d83f383c5154`。覆盖 admission/fence append reject、flush 后 exact/absent/unknown、durable fence ack lost 与 history load failure；正向执行通过 MockServer 全量 `/responses` 计数证明恰好一次，fence exact/unknown 则为零。
   - `just test -p crewon-core user_input_once_index --retries 0`：13/13 Green，Nextest run `506976a8-a4a7-4efa-a718-a9d764f9261b`。duplicate、unknown、wrong-thread marker 均 poison identity，不能保留首条 admission 为可恢复状态。
   - 其余覆盖 chronological resume index、v1/fork/unknown/mismatch/out-of-order/persisted-without-fence fail-closed、bounds、concurrent duplicate单模型请求、hash conflict、regular/once collision、`admission flush -> executionFence flush -> task`、fence不进入模型上下文、ordinary replay no-resubmit、exact v2 guarded resume、exact reservation success/mismatch、gate cancellation、effective-cwd match/mismatch与 cwd改变后的 exact replay。
   - protocol/core scoped fix与 `just fmt` 随后成功；按仓库规则未在最终 fix/fmt后重跑上述测试。
   - writer为 UnderDevelopment/default-off；execution fence不是下游执行receipt。test-only ack fault、local rollout single-writer、真实双 app-server graceful handoff与异常退出 lease 释放已 targeted Green，但 production activation、pre-fence artifact两阶段围栏与deployment SHA allowlist、真实 local writer fsync/power-loss与NFS语义、downstream model/tool/MCP idempotency/reconcile和完整 workspace suite仍未闭合。
15. Office stable identity + receipt + live Auto Delegation
   - `just test -p crewon-app-server --lib office_durable`：4/4 Green，Nextest run `8dc8c4cb-2b75-4745-a119-44017deedaa4`。
   - `just test -p crewon-app-server --lib office_dispatch_admission_identity`：4/4 Green，Nextest run `e542ef9c-0c44-4ba2-95ce-38afb7e02d4b`；`just test -p crewon-app-server --lib crewon_domain_office_dispatch_receipt`：7/7 Green，Nextest run `0f557edc-3ac6-430e-a2ce-93a3bbb0ead9`。
   - `just test -p crewon-app-server --lib dispatch_recovery`：19/19 Green，Nextest run `ee295009-7770-4a3e-9a38-84891ac1cced`；locator unknown-authority fail-closed 精确过滤 6/6 Green，Nextest run `aad0755f-e4c0-4db3-bff0-d091f2f3e9ab`。
   - `just test -p crewon-app-server --lib crewon_domain_office_run_dispatch_receipt`：receipt writer before-write/after-commit persistence seam 4/4 Green。
   - `just test -p crewon-app-server --lib crewon_domain_office_server_owned_fields`：7/7 Green，Nextest run `4f9c9077-e141-436e-9072-3fcc937cb7f0`。
   - gate-on `office_auto_dispatch_durable_admits_exact_delegation_once`：1/1 Green，Nextest run `e02207ff-183a-4806-9a98-5f4595f50b0e`；gate-off legacy回归首次发现 no-receipt旧 Office误要求 recordId，修复后 1/1 Green，Nextest run `1e839f99-95ac-4f43-a978-8df163120e12`。
   - `just test -p crewon-features` 未形成结果：依赖编译阶段因 `target/` 生成物耗尽磁盘而报 `No space left on device`；随后仅清理 Cargo 生成物释放约 53.9 GiB。Feature enum已通过 app-server定向编译与 live双 gate Harness覆盖，但该单包测试不记为 Green。
   - 当前结论包含local rollout single-writer、test-only writer ack fault、真实双 app-server graceful handoff、异常退出 lease 释放、app-server full suite与下列Office focused restart/reclaim/recovery targeted Green；不包含已撤销的volatile auto-recovery prototype，也未覆盖两阶段旧版本围栏/deployment SHA allowlist、真实power-loss/fsync与NFS语义、migration竞态或最终 core/workspace full suite，production activation保持Red。
16. Office durable restart/reclaim/downgrade Harness
   - 所有重启夹具先通过 `TestAppServer` 显式关闭 stdin 发送 EOF，并 bounded wait child 完全退出；只有退出完成后才采集最终 Office/scheduler/rollout bytes、改写故障状态或建立第二次重启的精确比较基线，避免旧进程在播种后继续持久化。
   - `office_auto_dispatch_durable_starting_recovery`：覆盖 `starting` restart 与 expired child/scheduler lease reclaim。
   - `office_auto_dispatch_durable_sidecar_recovery`：覆盖 admitted receipt + expired scheduler sidecar restart，并保持 Office 与 receipt 精确字节不变。
   - `office_auto_dispatch_durable_after_commit_ambiguous_recovery`：重启前成员 rollout 无 marker/turn；恢复后恰好一个 v2 admission、一个 matching execution fence、一个 turn/model request，第二次重启保持 Office/scheduler/rollout字节幂等。phase断言修复后1/1 Green，Nextest run `7ce5d2bb-cd84-44e5-a247-4cce2c5c4b92`。
   - `office_auto_dispatch_durable_v2_admission_recovery`：成员 rollout只有 exact v2 admission、没有 execution fence/UserMessage/lifecycle evidence；Office recovery显式 guarded resume同一 turn，恰好一个模型请求并完成，第二次重启不重放。早期 targeted 1/1 run `fbb5384d-230e-4b7e-a323-92ca5134f88d`；task-start-loss fail-closed 接线后的最终精确重跑 1/1 Green，Nextest run `f238dc62-18bd-439a-97cb-70fdca380352`。
   - `office_auto_dispatch_durable_marker_only_quarantine`：成员 rollout被降为 legacy v1 marker且没有 UserMessage/terminal turn；重启后模型请求为零，Office receipt与 scheduler进入 exact `executionUnknown`、lease清空，并发出 `autoDispatchExecutionUnknown`；第二次重启 Office/scheduler/rollout字节幂等。1/1 Green，Nextest run `fa0ecc93-8a36-4bfe-b6c3-b2638d2f7598`。
   - `office_auto_dispatch_durable_active_attach`：用 oneshot确认 exact member模型请求已进入并阻塞响应；同进程把 scheduler播种为 expired `dispatching` 后通过 `office/read` 触发生产 recovery，receipt保持 admitted、scheduler回到 dispatched、Office bytes不变、exact task总请求仍为一；释放响应后正常完成。
   - `office_auto_dispatch_durable_partial_commit_recovery`：Office receipt已为 `executionUnknown`且 child lease已清除，scheduler仍为 expired `dispatching`；重启只补齐 scheduler exact identity/terminal state，Office与 marker-only rollout bytes不变且 recovery server总请求为零；第二次重启通过同步 `office/read` 完成 drain 后继续字节幂等。
   - `office_auto_dispatch_durable_downgrade_recovery`：durable gate off、receipt `starting`、delegation `queued`、无 `turnId`、expired lease且已有 durable identity时，只按原 identity fail-closed drain；member turn、rollout bytes与模型请求不增加，不创建新的 v2 resume。1/1 Green，Nextest run `0b1f7fff-ac38-4bdd-8c63-9dc69d6dd204`。
   - 首次新combined run `56f2bc44-...` 因旧断言仍要求marker总数为1而8/9；断言改为phase精确计数 `admission=1`、`executionFence=1` 后的历史 9/9 run 为 `1e35cd66-1ff3-41bd-815f-a801a6cacaf9`。本轮加入 fence ack fail-closed 后再次执行 `just test -p crewon-app-server --test all office_auto_dispatch_durable_ --retries 0`，最新 9/9 Green，Nextest run `669bf807-1544-4c34-a586-d3ce21a46bd8`。这不是完整 app-server/workspace suite，也不是external exactly-once证明。
   - change-size review：active-attach Harness 439 行、partial-commit Harness 434 行，均低于复杂切片 500 行限制且文件/场景互相独立；若进入 PR，应拆为两个 review unit，避免把合计 873 行测试改动作为单个非机械 review slice。

17. Local rollout single-writer lease + handoff
   - `just test -p crewon-rollout --retries 0`：77/77 Green，Nextest run `98074dc8-657e-455a-a0ef-1dac15d25277`。覆盖同 thread fail-fast、不同 thread并行、active/archived/plain/compressed alias、shutdown/discard确定释放、真实子进程竞争，以及活跃 writer 时压缩跳过、shutdown 后压缩。
   - `just test -p crewon-thread-store --retries 0`：92/92 Green，Nextest run `c02a583c-d8de-4a37-974d-5ca320f5c708`。覆盖双 store竞争/handoff、stale与同长度变更history、malformed与wrong-thread fail-closed、live metadata无自锁、cold metadata冲突前SQLite不变，以及archive/unarchive/delete冲突无路径 mutation。
   - scoped fix/fmt 在上述测试后执行；按仓库规则不在最终 fix/fmt后重跑。该 wave若进入 PR应拆成两个 review unit：A为 recorder lease + handoff + metadata，B为 compression + archive/unarchive/delete path mutation；不得把全部非机械改动作为单个超800行 review slice。
   - 未覆盖：F2b-3d6c Stage D clean-tree真实release、三个Legacy相关真实release conflict probe、immutable production artifact/SHA authority与atomic verify+exec wiring、pre-fence旧binary混跑部署阻断、fsync/power-loss及NFS/非本地文件系统锁语义。

18. Real app-server handoff + abrupt-exit release + error mapping
   - `two_app_server_processes_serialize_rollout_writer_handoff`：两个真实 `TestAppServer` 进程共享同一 `CREWON_HOME` 和 rollout。A resume/append 并持有 writer；B 同时 resume 返回 JSON-RPC `-32600`，错误包含 active rollout writer，B 不能 inject且文件不变；A shutdown后B可resume/append，最终A/B marker各恰好一次。1/1 Green，Nextest run `17429c41-974e-4d93-becc-93f99c97a8f6`。
   - `cross_process_writer_lock_is_released_after_abrupt_exit`：child获取lease并发ready marker，parent先观察WouldBlock；kill child后parent立即获取同一lease。1/1 Green，Nextest run `5c67d54e-2882-43c3-8110-fdb40c7764fb`。该证据是进程异常退出后的OS lease释放，不是断电后rollout bytes durability证明。
   - `just test -p crewon-core session_rollout_init_error --retries 0`：2/2 Green，Nextest run `d032f79a-2c0b-41e8-8b76-3c496ee95e50`。证明 `ThreadStoreError::Conflict` 映射为可预期 invalid-request，`ThreadNotFound` 保持原错误身份，避免writer竞争被误报为内部错误。
   - release compatibility仍Red：pre-fence binary不检查新lease/generation lock，新binary单方面增加lock无法形成阻断。F2b-3d6c Stage A-C已Green；只有Stage D在clean tree产出并probe真实release，且production launcher/container在exec前原子验证并拒绝pre-fence SHA后，才能声称部署边界闭合。

19. Rollout writer generation substrate + standalone deployment verifier
   - `generation_lock` matrix：同进程shared、legacy exclusive、shared-vs-exclusive、canonical/symlink home、跨进程shared/exclusive及kill释放共6/6 Green，Nextest run `435432c6-bd5e-4dc1-8113-ca4f430d90c3`。
   - `just test -p crewon-rollout --retries 0`：加入generation lock后的84/84 Green，Nextest run `542733ca-066a-4c2c-aa53-7939373800f1`。
   - app-server默认编译mode `LeaseAwareShared`与incompatible generation fail-closed 2/2 Green，Nextest run `bd8a7a23-2b30-4743-a1e7-cf80128f39f0`；`legacy-fence-artifact` feature编译mode `LegacyFenceExclusive`对应2/2 Green，Nextest run `a1b67eea-3d17-4f04-9cdd-ffa839fac47c`。
   - standalone deployment verifier、black-box probe与builder的三个Python unittest文件合计39/39 Green，`py_compile`通过。builder默认拒绝dirty tree，固定从`codex-rs` pinned toolchain执行`cargo --frozen --release --no-default-features`，两generation使用隔离target dir；记录并复核`Cargo.lock` SHA与完整Git HEAD/status快照，子进程使用分类硬超时和进程组清理，复制到临时stage后生成两套只读manifest/allowlist和non-authoritative receipt，全部成功后才使用macOS/Linux原子no-replace rename到最终output。
   - generation probe不读取manifest或binary自报generation，候选binary只继承最小环境白名单，共享home用有界类型/inode/size/time/SHA快照检测新增、删除和原地篡改，特殊/超限/扫描变化均fail closed，并在leader退出后仍确认整个进程组回收。exact matrix为：`leaseAware+leaseAware -> bothInitialized + distinct ports`，以及`legacy+legacy`、`legacyOwner+leaseAwareContender`、`leaseAwareOwner+legacyContender`三组`conflictBeforeStateOrListener`。builder拒绝缺失、重复、额外或错误case，并逐项核对probe返回的lease/legacy artifact path、SHA与size等于刚构建identity；probe后还会重新hash artifact，变化则不发布。`--allow-dirty --dry-run`已确认实际解析为Rust 1.95.0、target `aarch64-apple-darwin`、工作目录`codex-rs`以及两条隔离target dir的frozen release构建命令。
   - 当前真实workspace为dirty tree，builder按默认策略拒绝生成authoritative-looking output；因此两套真实release尚未构建，三个Legacy相关真实release conflict probe均未执行。`--allow-dirty`/`--skip-generation-probe`只属于显式development mode，receipt仍标记non-authoritative。
   - standalone verifier和builder receipt均明确`productionWiring:notConnected`。Python verifier校验后关闭fd，若后续按path exec仍存在TOCTOU；当前production binary/container authority及macOS/Linux/container atomic launcher方案未选择，不能关闭Stage D或deployment SHA Gate。
- F2b-3d6c仍未完成：Stage A/B/C已有闭合证据，Stage D只有build/probe substrate；真实release、production authority与atomic verify+exec wiring仍Red。

20. 本地开发启动等待效率附注
   - `scripts/crewon-dev.sh` 的默认backend ready timeout由360秒调整为900秒，以覆盖冷Cargo编译并减少“服务仍在正常编译却被dev supervisor过早判失败”的重复重启。真实故障注入发现并修复了macOS Bash 3.2在`set -u`下展开空listener PID数组导致monitor退出的问题：受控停止旧app-server PID 17350后，UI持续HTTP 200，supervisor自动拉起新PID 18264，`readyz`恢复200，随后经5175代理的WebSocket `initialize -> initialized`成功。该证据只证明本地dev自愈，不是Stage D release、production readiness或durability证据。

本次combined durable filter最新9/9 Green（run `d88fd93d-a716-4a96-b4f8-0064bc35c39b`）；完整`crewon-app-server` suite 1252/1252 Green（run `1c9096c2-160c-4fec-a33e-1f1bab7d5fa4`）。workspace `just test`未运行，workspace全量按仓库规则仍需用户明确授权。

## 未验证

- external execution ambiguity：v2 fence已把可显式恢复的admission-only/no-evidence与必须quarantine的legacy/ambiguous/越界状态分开，exact active attach、Office-first/scheduler-lagging单边收敛、test-only writer ack fault、local rollout single-writer、真实双app-server handoff、异常退出lease释放与generation substrate均有direct Harness；但fence不是external side-effect receipt。仍缺downstream model/tool/MCP idempotency/reconcile、Stage D clean-tree真实release/三个Legacy conflict probe、真实production artifact authority与atomic launcher/container SHA Gate、真实local writer fsync/power-loss与NFS语义、其余receipt/rollout/scheduler fault matrix、rollout rollback/compaction、release activation gate和migration竞态证明。builder/probe/verifier的`productionWiring:notConnected` substrate不足以开启durable feature。
- migration-owned reconcile + source CAS advance、stable claim/receipt/permit 顺序，以及最终 Harness 改动后的 startup/runtime repair full-suite Green。当前 isolated repeat 已 Green。
- strict corrupt legacy file quarantine、memory identity 切换与 sidecar hard bounds。
- Production importer admission、active Run 的生产 quiescing stop/reconcile、所有旧 dispatch/sidecar fence 的全量覆盖。Importer 继续 disabled。
- W3-04 Typed Aggregate 与任何生产切换。
