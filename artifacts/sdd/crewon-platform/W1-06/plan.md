# W1-06 Implementation Plan

## Stage A1: Schema and records

1. 新增 `0037_task_runtime.sql`，在同一 state migrator 建立 Tasks/Attempts/Events/Inbox/Outbox/Cursors/Migration Journal。
2. 在独立 `task_runtime_records.rs` 定义 bounded storage records 和 validation error。
3. migration Harness 从真实当前 schema 升级并检查表、索引、数据库文件边界。

Review 边界：migration + records 独立评审，生产实现低于 500 LoC。

## Stage A2: Atomic append

1. 在独立 `runtime/task_runtime.rs` 实现 create/commit，在 `runtime/task_runtime_read.rs` 实现 read/page projection。
2. 使用 `BEGIN IMMEDIATE`，按 Inbox -> Event -> CAS/Fencing -> Snapshot -> Attempt -> Event -> Inbox -> Outbox 顺序执行。
3. 用同 commit 内重复 outbox ID 注入中途 SQL failure，证明 rollback。
4. close/reopen 比较 Task/Event/Inbox/Outbox 完整 records。

Review 边界：atomic append 与 focused Harness 分开，复杂模块低于 500 LoC。

## Stage B: Recovery, cursor, fencing

1. 实现 event list、cursor CAS/无 gap、pending outbox list/deliver。
2. 并发提交同 version，证明单 winner。
3. 覆盖 WorkerRun/epoch/hash/expiry mismatch。
4. 实现 migration journal read/create 完整幂等语义。

## Stage C: Adapter without composition

1. 为 Resource Binding、Task Contract、Attempt、Task Aggregate 增加公开 persistence Snapshot DTO 和受校验 restore。
2. restore 复验 capability/mode/location/materialization、workspace/binding 唯一性、Attempt shape/ordinal/active pointer、Task lifecycle、version/offset/event cardinality。
3. 在 app-server 独立模块实现 `TaskStore` adapter，显式转换 W1-05 Domain 和 State Record。
4. 只做 compile/integration Harness，不注册 processor 或双写旧 Office。
5. 中心接线和 cutover 留给 W1-10。

## Verification

1. `just test -p crewon-resource-federation`、`just test -p crewon-task-runtime`、`just test -p crewon-state`、adapter targeted test 和 `just test -p crewon-app-server`。
2. `just fix -p crewon-resource-federation`、`crewon-task-runtime`、`crewon-state`、`crewon-app-server`，最后 `just fmt`。
3. 不运行完整 workspace test，除非用户明确批准此前 protocol/common 变更的全量验证。
