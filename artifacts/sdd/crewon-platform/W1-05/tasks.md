# W1-05 Tasks

## A. Contract and aggregate

- [x] A1 新建 `crewon-task-runtime` 和最小 workspace/build wiring。
- [x] A2 定义 bounded Task/Attempt/WorkerRun/Command/Event/Idempotency IDs。
- [x] A3 定义不可变 TaskContract、TaskAuthority 和 Single/Office StrategyKind。
- [x] A4 定义 TaskAggregate、Attempt、Lease/Fencing、状态和有界集合。
- [x] A5 添加 genesis、Authority、binding/attempt limit tests。

## B. Command and reducer Harness

- [x] B1 表驱动 accept/start/progress/suspend/resume/complete/cancel。
- [x] B2 实现 Attempt failure -> RetryDecision -> retry/final fail。
- [x] B3 实现 OutcomeUnknown -> Reconciling -> same-attempt terminal resolution。
- [x] B4 覆盖错误 Authority、非法状态转移和终态不可回退。
- [x] B5 覆盖 event offset、worker sequence、Lease expiry、epoch/token/WorkerRun mismatch。
- [x] B6 用完整 Aggregate equality 验证每次 reducer 结果。

## C. Ports and atomic fake store

- [x] C1 定义 documented RPITIT TaskStore 与 WorkerExecutor。
- [x] C2 定义 TaskCommit、Inbox receipt、Outbox/SchedulerDecision 和 CAS error。
- [x] C3 实现 test-only InMemoryFakeStore。
- [x] C4 覆盖 duplicate command/event 不重复写 Event/Attempt/Outbox。
- [x] C5 覆盖 expected version CAS conflict 和原子失败无部分状态。

## D. Verification

- [x] D1 `just test -p crewon-task-runtime`。
- [x] D2 dependency boundary script。
- [x] D3 Bazel lock update/check。
- [x] D4 staged change-size review，领域模块均低于 500 LoC。
- [x] D5 scoped fix，最后 fmt，并记录未接消费者。
