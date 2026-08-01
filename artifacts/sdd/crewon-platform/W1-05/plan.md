# W1-05 Implementation Plan

## Stage A: Bounded aggregate contract

1. 新建 `crewon-task-runtime`，依赖 `crewon-resource-federation` 与 `serde`，不接 common/core/protocol。
2. 定义 bounded IDs、TaskContract、TaskAggregate、Attempt、Authority、Single/Office Strategy 和状态闭集。
3. Contract、Resolved bindings、Attempt 列表和所有字符串建立硬上限。
4. 测试完整对象 genesis、Authority 不可变和构造上限。

Review 边界：model/aggregate implementation 与测试独立成 W1-05A，目标低于 800 changed lines。

## Stage B: Harness-first command/reducer

1. 先写表驱动状态机测试和 terminal property/model test。
2. 定义 Command/WorkerEvent/CommittedEvent/SchedulerDecision。
3. 实现纯 `decide_command` 与 `reduce_event`，不做 I/O。
4. 覆盖 accept/start/progress/suspend/resume、failure retry decision、unknown reconciliation、cancel/complete/final fail。
5. 覆盖错误 Authority、offset gap、重复/乱序 sequence、Lease expiry、旧 fencing token。

Review 边界：reducer/decision 和对应 Harness 独立成 W1-05B；每个领域模块低于 500 LoC。

## Stage C: Ports and transactional Fake Store

1. 定义 documented RPITIT `TaskStore` 和 `WorkerExecutor` port。
2. 定义 Inbox receipt、TaskCommit、Outbox/Scheduler decision 和 CAS error。
3. 在 test module 实现 `InMemoryFakeStore`，原子模拟 event offset、snapshot、Inbox、Outbox。
4. 证明 duplicate command/event 无重复副作用、CAS 冲突安全、一个 Task 只有一个 Authority。

Review 边界：ports + FakeStore Harness 独立成 W1-05C；不实现 SQL/HTTP/Provider。

## Stage D: Verification

1. `just test -p crewon-task-runtime`。
2. 运行 dependency boundary script，禁止 core/app-server/sqlx/reqwest/具体 Provider。
3. Cargo dependency 变化执行 Bazel lock update/check。
4. `just fix -p crewon-task-runtime`，最后 `just fmt`，之后不重跑测试。

