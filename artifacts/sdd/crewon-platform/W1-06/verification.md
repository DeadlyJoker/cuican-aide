# W1-06 Verification

状态：实现、行为回归、scoped fix 与最终 fmt 完成。

## Evidence matrix

| Requirement | Evidence |
| --- | --- |
| same SQLite lifecycle | 临时 StateRuntime 目录严格保留既有 `state_5.sqlite`、`logs_2.sqlite`、`goals_1.sqlite`、`memories_1.sqlite` 四个文件；Task 表位于 `state_5.sqlite` |
| real schema upgrade | 从真实 0036 schema 初始化并升级到 0037，七组表及索引可查询 |
| atomic append | 同一事务写 Snapshot/Attempt/Event/Inbox/Outbox；重复 outbox ID 注入中途失败后完整 rollback |
| reopen durability | close/reopen 同一 home 后 Task/Event/Inbox/Outbox deep equality |
| CAS | 两个相同 expected version 的并发 commit 仅一个成功 |
| Inbox/Event idempotency | duplicate receipt 返回原 Snapshot；duplicate Event 不补写 receipt，均无额外 outbox |
| fencing | WorkerRun/epoch/hash/expiry 不匹配返回 Fenced，adapter 映射为 `TaskStoreError::Fenced` 且无副作用 |
| cursor gap | cursor 只允许 expected+1 且对应 Event 已存在 |
| outbox recovery | pending outbox 重启后仍可查询；delivered 重复标记幂等 |
| snapshot validation | Resource capability/materialization tamper、Task unknown fields/集合上限/非法 Attempt 与 lifecycle/version history 均 fail-closed |
| dependency boundary | `crewon-state` 不依赖 `crewon-task-runtime`；领域到 storage 的转换只在 app-server adapter |
| composition boundary | 未注册 RPC/processor/scheduler，未修改旧 Office authority，未做 dual write |

## Commands and results

- `just test -p crewon-resource-federation`: 10 passed, 0 skipped。
- `just test -p crewon-task-runtime`: 23 passed, 0 skipped。
- `just test -p crewon-state`: 153 passed, 0 skipped。
- `just test -p crewon-app-server task_state_store_adapter`: 3 passed, 1010 filtered/skipped by test filter。
- `just test -p crewon-app-server`: 1012 passed, 1 skipped by existing condition。
- `just bazel-lock-update`: passed；仅输出仓库既有 third-party crate annotation warning。
- `just bazel-lock-check`: passed。
- `just fix -p crewon-resource-federation`: passed。
- `just fix -p crewon-task-runtime`: passed。
- `just fix -p crewon-state`: passed。
- `just fix -p crewon-app-server`: passed；保留 5 个本 Wave 范围外的既有 app-server lint warning。
- `just fmt`: passed；按仓库规则在 fix/fmt 后不重复运行测试。

## Review boundaries

- 所有新增生产 Rust 模块均低于 500 LoC。
- migration 已由现有 State crate Bazel `compile_data` glob 覆盖。
- 未新增 SQLite 文件、pool、secret/raw Provider payload 字段。
- 未运行完整 workspace `just test`：此前 protocol/common 变更的 workspace 全量测试仍需用户明确批准；本 Wave 相关 crate 已完整覆盖。
