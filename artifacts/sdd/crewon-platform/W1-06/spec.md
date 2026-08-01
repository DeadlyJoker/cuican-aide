# W1-06 Specification: crewon-state Task 持久化

## 1. 目标

在现有 `crewon-state`、`state_5.sqlite`、WAL、迁移、恢复、备份和遥测生命周期中加入 Task Runtime records。State 层只保存并原子比较事实，不拥有 Task Reducer、Strategy、retry 或 Provider 逻辑。

Domain ↔ Record 映射由独立 app-server adapter 完成；本阶段禁止 `crewon-state -> crewon-task-runtime` 依赖，也禁止第二个 SQLite 文件、shadow write 或旧 Office JSON 双写。

## 2. 现状边界

- `StateRuntime` 已唯一持有 `state_5.sqlite` pool，并通过 `runtime_state_migrator()` 使用容忍新版本的 sqlx migrator。
- state migrations 已到 `0036`；新增 migration 必须进入同一 `state/migrations`，现有 Bazel `compile_data` 已覆盖该目录。
- `StateRuntime` 使用最多 5 个 SQLite connections、WAL、Normal synchronous 和 5 秒 busy timeout。
- 现有 runtime 子模块使用显式 SQL transaction / `BEGIN IMMEDIATE` 实现原子 claim 与 CAS，应复用该模式。
- `crewon-task-runtime` 的 Aggregate/Reducer 不能进入 state；state records 使用 transport-neutral String/integer/JSON text，由 adapter 显式验证和映射。

## 3. 最小 schema

### 3.1 `task_runtime_tasks`

保存当前权威 Snapshot 和 CAS/fencing 投影：

- `task_id` primary key。
- authority、strategy、status。
- contract JSON、snapshot JSON。
- aggregate version、task stream offset。
- active Attempt、WorkerRun、lease epoch、fencing token hash、lease expiry。
- created/updated timestamp。

Contract 和 Snapshot JSON 有字节硬上限；state 不解析领域字段，但显式列用于 CAS、查询和 fencing defense-in-depth。

### 3.2 `task_runtime_attempts`

按 `(task_id, attempt_id)` 保存 ordinal、status、idempotency key、WorkerRun、lease/fencing、last producer sequence 和 bounded attempt JSON。`UNIQUE(task_id, ordinal)` 防止并发创建相同 ordinal。

### 3.3 `task_runtime_events`

按 `(task_id, stream_offset)` 保存 append-only Event：

- event ID、event type、bounded event JSON。
- Attempt/WorkerRun/producer sequence。
- lease epoch/token hash。
- occurred/received timestamp。

唯一约束：

- `(task_id, event_id)`。
- 对 Worker fact，`(task_id, attempt_id, worker_run_id, producer_sequence)`。

### 3.4 `task_runtime_inbox`

按 `(task_id, receipt_kind, receipt_id)` 保存已处理输入和原始提交结果：result aggregate version、stream offset、result snapshot JSON、created timestamp。重复输入返回原提交结果且不新增 Event/Outbox。

### 3.5 `task_runtime_outbox`

保存稳定 outbox ID、Task/version、decision type、bounded payload JSON、pending/delivered 状态、delivery attempts、available/created/delivered timestamp。Outbox 不保存 Secret 或 Provider raw body。

### 3.6 `task_runtime_cursors`

按 `(consumer_id, task_id)` 保存已确认 stream offset。第一版逐 Event 推进，禁止跳过不存在或未确认的 offset。

### 3.7 `task_runtime_migration_journal`

按 `(source_kind, source_id, source_revision)` 保存 migration hash、target task ID、status 和 timestamp，供后续旧 Office importer 防止重复导入。W1-06 建表；实际 importer 由 W1-10 实现。

## 4. Record API

State 公开无领域决策的 bounded records：

- `TaskRecord`
- `TaskSnapshotRecord`
- `TaskAttemptRecord`
- `TaskEventRecord`
- `TaskInboxRecord`
- `TaskOutboxRecord`
- `TaskCommitRecord`
- `TaskLeaseRecord`

JSON text、ID、status/type 和集合均在进入 SQL 前有硬上限。错误不回显 JSON body、token hash 或完整 SQL record。

## 5. 原子 create/commit

### 5.1 Create

`create_task_record` 在 version/offset 均为 0 时插入 Task Genesis；重复 Task ID 返回 `AlreadyExists`，不覆盖 Contract。

### 5.2 Commit 固定顺序

使用 `BEGIN IMMEDIATE`：

1. 查询 Inbox receipt；存在则直接返回保存的原始结果。
2. 查询 event ID 和 Worker producer tuple；存在但 Inbox 不一致则返回 `DuplicateEvent`，不补写 receipt。
3. 读取当前 Task version/offset/fencing projection。
4. 校验 `expectedVersion`、`nextOffset = current + 1`。
5. Worker commit 校验 Attempt、WorkerRun、lease epoch、token hash 和 `receivedAt <= expiresAt`；失败返回 `Fenced`。
6. CAS 更新 Task Snapshot/投影。
7. upsert 当前 Attempt record。
8. append Event。
9. insert Inbox result。
10. insert 0..N bounded Outbox records。
11. commit transaction。

任一 SQL/validation 失败 rollback，不能留下部分 Event、Snapshot、Inbox 或 Outbox。

## 6. Commit outcome

闭集：

- `Committed(TaskRecord)`
- `DuplicateInbox(InboxResultRecord)`
- `DuplicateEvent`
- `Conflict`
- `Fenced`

Cursor 使用独立 `TaskCursorAdvanceOutcome::{Advanced, Conflict, Gap, NotFound}`，不混入 Task commit outcome。

SQLite corruption/IO/constraint errors使用 `anyhow::Error` 向上返回，由现有 StateRuntime recovery/telemetry 处理；不把基础设施错误伪装成领域状态。

## 7. Cursor 与 Outbox recovery

- `list_task_events(task_id, after_offset, limit)` 只按 stream offset 升序返回，limit 有硬上限。
- `advance_task_cursor` 使用 expected offset CAS，第一版只允许 `next = expected + 1` 且 Event 已存在。
- `list_pending_task_outbox(now, limit)` 在重启后返回 pending records。
- `mark_task_outbox_delivered` 只允许 pending -> delivered；重复 delivered 幂等。

## 8. Concurrency/Fencing

- 两个基于同一 Aggregate version 的 claim/commit 最多一个成功。
- Claim/Reclaim 的新 lease projection 由 Authority commit 写入；State 不判断 Task status，但要求 version/offset CAS。
- Worker commit 必须匹配当前 persisted Attempt/Worker/epoch/hash/expiry，旧 Worker 即使掌握旧 Event payload 也不能更新 Snapshot。
- token hash 是 bounded canonical hash；原始 fencing token 不进入 state API 或数据库。

## 9. 分阶段落地

### W1-06A Records + Atomic Append

- migration 七组表和索引。
- bounded records。
- create/read、atomic commit、Inbox/Event dedupe、CAS、fencing projection、Attempt upsert、Outbox insert。
- reopen 与 rollback Harness。

### W1-06B Claim/Recovery/Cursor

- 并发 commit/claim Harness。
- cursor advance/list events。
- pending outbox recovery/delivery。
- old fencing/expiry matrix。
- migration journal operations。

### W1-06C app-server Adapter

- Resource Binding、Task Contract 和 Task Aggregate 使用公开 Snapshot DTO；反序列化后必须重新执行领域校验，禁止直接反序列化内部对象。
- 独立 `task_state_store_adapter` 显式映射 W1-05 Domain ↔ State records。
- 不注册 RPC/processor，不切换旧 Office Authority；中心 composition 留给 W1-10。

## 10. 非目标

- SQL 内 reducer、status transition、retry policy 或 Strategy 分支。
- 新数据库文件、独立 SQLite pool/lifecycle 或 shadow write。
- Provider/HTTP/Queue/UI。
- 旧 Office importer 执行或 API composition。
- Cloud/Postgres Store。

## 11. 验收

1. 临时目录 StateRuntime 写入、close、reopen 后完整 Record deep equality。
2. 当前真实 schema 可迁移，且目录中不出现第五个/额外 Task SQLite 文件。
3. duplicate Inbox/Event、CAS、cursor gap、old fencing、expired lease 均 fail-closed。
4. 插入多个相同 outbox ID 触发中途失败时整个 transaction rollback。
5. pending Outbox 在 reopen 后恢复。
6. Resource/Task Snapshot tamper、未知字段、集合上限和状态机不变量 fail-closed。
7. `just test -p crewon-state`、Resource/Task domain tests、adapter targeted tests 和 app-server crate tests 通过。
