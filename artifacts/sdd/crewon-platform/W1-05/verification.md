# W1-05 Verification

状态：W1-05 scoped implementation 与 verification 完成；尚未接入 app-server、crewon-state、Provider 或 UI。

## Transition matrix

| Input | From | To | Scheduler decision | Evidence |
| --- | --- | --- | --- | --- |
| AcceptTask | Created | Queued + Attempt Created | EnqueueAttempt | success lifecycle test |
| ClaimAttempt | Queued | Running + Attempt Started | DispatchAttempt | success lifecycle test |
| Progressed | Running | Running | NoAction | success lifecycle test |
| Suspended | Running | Suspended | AwaitResume | success lifecycle test |
| Resumed | Suspended(Provider/Approval) | Running | NoAction | success lifecycle test |
| Failed worker event | Running/Reconciling | Suspended(RetryDecision) | AwaitRetryDecision | retry/reconcile test |
| ScheduleRetry | Suspended(RetryDecision) | Queued + next Attempt | EnqueueAttempt | retry/reconcile test |
| FailTask | Suspended(RetryDecision) | Failed | NoAction | final decision test |
| OutcomeUnknown | Running | Reconciling | Reconcile same Attempt | retry/reconcile test |
| Succeeded | Running/Reconciling | Completed | NoAction | success + reconcile tests |
| CancelTask | active non-terminal Attempt | Cancelled | CancelAttempt | final decision test |
| CancelTask | failed Attempt awaiting decision | Cancelled | NoAction | final decision test |
| ReclaimAttempt | expired current Lease | same Task state + new Worker/epoch | Dispatch/Await/Reconcile by state | reclaim tests |

## Invariant evidence

| Invariant | Evidence |
| --- | --- |
| terminal never rolls back | all 3 terminal statuses x all 7 Command and 7 Event kinds |
| duplicate input has no duplicate side effect | FakeStore domain snapshot deep equality for command and worker event |
| one immutable Authority | wrong-authority command rejected before decision |
| Worker event is current | attempt/worker/epoch/token/expiry rejection matrix |
| sequence is monotonic | second distinct event with same sequence rejected |
| unknown cannot retry | Reconciling rejects ScheduleRetry; same Attempt may resolve terminal |
| fencing epoch is continuous | reclaim requires exact `oldEpoch + 1` |
| transaction is atomic | injected backend failure leaves Event/Snapshot/Inbox/Outbox deep-equal |
| CAS prevents double decision | two version-zero commits produce one success and one conflict |
| Executor cannot create Attempt | WorkerExecutor exposes only typed start/cancel/reconcile |
| operation types cannot be confused | separate WorkerDispatch/WorkerCancellation/WorkerReconciliation constructors |
| expired Lease cannot dispatch | typed Worker constructors reject expired Lease |

## Review stages and size

The implementation should be reviewed/landed as coherent stages rather than one 3K-line change:

1. W1-05A1: bounded value objects + enums (`value.rs` 376 LoC, `model.rs` 167 LoC) and focused guards.
2. W1-05A2: TaskContract/Aggregate/Attempt (`aggregate.rs` 256 LoC) and aggregate Harness.
3. W1-05B1: Event/Command contract (`event.rs` 164 LoC, `command.rs` 279 LoC) plus lifecycle cases.
4. W1-05B2: Reducer core (`reducer.rs` 426 LoC) plus transition Harness.
5. W1-05B3: terminal/fencing/sequence property matrix, independently reviewable test-only stage.
6. W1-05C1: Store/Worker ports (`store_port.rs` 199 LoC, `worker_port.rs` 203 LoC) and compile Harness.
7. W1-05C2: transactional InMemoryFakeStore and atomicity/CAS/idempotency Harness.

All production domain modules are below 500 LoC. Each review stage remains below the 800-line limit when paired with its focused tests.

## Test and build evidence

- Harness red phases were observed before W1-05A and W1-05B implementation.
- `just test -p crewon-task-runtime`: 19 passed, 0 skipped.
- `task-runtime/scripts/check-dependency-boundary.sh`: passed.
- `just bazel-lock-update`: passed; emitted only existing rules_rs well-known crate annotation warnings.
- `just bazel-lock-check`: passed.
- `just fix -p crewon-task-runtime`: passed with no remaining warning.
- `just fmt`: passed; tests were not rerun after fix/fmt per repository rules.
- `git diff --check`: passed.

## Dependency boundary

Allowed production dependencies: `crewon-resource-federation`, `serde`.

Forbidden and absent: `crewon-core`, `crewon-app-server`, `crewon-state`, `sqlx`, `reqwest`, UI and concrete Provider crates.

## Deferred composition

- No app-server API/processor route or existing Office JSON/dispatch lease was modified or dual-written.
- W1-06 must implement Task records and atomic transaction semantics in the existing `crewon-state` lifecycle; it must not move the Reducer into state.
- W1-10 maps domain Strategy/Status/Event refs to v2 DTOs explicitly; current canonical wire is not treated as the domain authority.
- W2-07 maps Local/Cloud executor facts into Worker events; Provider adapters cannot create Attempts or choose retry.
- Full Rust workspace tests were not run because earlier Wave work changed protocol and repository rules require explicit user approval for the full suite.

## W2-07 P1 amendment evidence（2026-07-21）

- 新增 ExecutionSpecRef，Task Contract schema 限定为 v2，canonical hash 绑定 execution spec 与排序后的 resource bindings。
- snapshot execution spec tamper 返回 ContractHashMismatch；WorkerDispatch 只携带 metadata ref，不携带正文或 Secret。
- Task Runtime：28 passed；app-server：1014 passed，1 skipped；schema 收紧后的 adapter 3 项与 Wave 1 Gate 1 项再次通过。
- dependency boundary、Bazel lock update/check 通过；仓库无非测试 TaskContract 创建调用点，因此没有已接线生产 snapshot 需要兼容。
