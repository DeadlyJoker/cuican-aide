# W1-09 Verification

状态：W1-09 实现与定向验证完成；尚未接入消费者主链路。

## Current findings

- Office upsert 会移除 inline content 并留下 digest/bytes，但 artifact 仍是 client-owned JSON，且保留 path/url/meta。
- Structured Office artifacts 没有 immutable revision、server actor/workspace、Retention、payload tombstone 或 idempotency。
- Task event/outbox 是 bounded JSON，但尚无强制 PayloadRef adapter。
- 现有 `state/src/audit.rs` 仅用于 thread DB diagnostics，不是产品 Audit Event。

## Required matrix

| Case | Expected | Evidence |
| --- | --- | --- |
| Secret payload | reject | `crewon-artifact` Harness passed |
| body Debug/Serialize | redacted/non-serializable | `PayloadBody` Harness passed |
| create/read | manifest + exact bytes | State + app-server round-trip passed |
| duplicate create/event | existing same, no duplicate | State Harness passed |
| idempotency mismatch | conflict | State Harness passed |
| delete payload | tombstone, no bytes | State Harness passed |
| retention expiry | bounded batch | State Harness passed |
| audit after delete | metadata retained, no body | State Harness passed |
| restart | refs/tombstone/idempotency retained | State Harness passed |
| serialization/DB scan | no Secret/raw Tool payload | JSON assertions + SQLite main/WAL byte scan passed |
| server actor/workspace | derived, not declared client | app-server Harness passed |
| unknown external outcome | bounded errorCode only；raw provider text rejected | `audit_unknown_outcome_is_bounded_and_never_carries_external_error_text`、`audit_record_accepts_unknown_outcome_but_rejects_unstructured_error_text` |

## Commands

- `just test -p crewon-artifact`：8 passed。
- `just test -p crewon-state artifact`：8 passed，153 skipped。
- `just test -p crewon-app-server artifact_adapter`：4 passed，1017 skipped。
- `just test -p crewon-app-server policy_adapter`：2 passed，1019 skipped。
- `just test -p crewon-state`：161 passed。
- `just test -p crewon-app-server`：1020 passed，1 skipped。
- `just bazel-lock-update`：passed；仅输出既有 well-known crate annotation warnings。
- `just bazel-lock-check`：passed。
- `just fix -p crewon-state`：passed，并应用 9 个机械修复。
- `just fix -p crewon-app-server`：passed；仅保留 5 个既有 Office/Agent Platform warning。
- `just fix -p crewon-artifact`：passed，无 warning。
- `just fmt`：passed。
- 按仓库规则，fix/fmt 后未重跑测试；未运行需要用户单独授权的完整 workspace `just test`。

## W2-05 consumer amendment（2026-07-23）

- `AuditOutcome::Unknown { errorCode }` 已作为 additive domain variant 落地；timeout、transport ambiguity 或 completion durability failure 不再需要伪装成 failed/succeeded。
- State `metadataJson` strict schema 同步接受 `type=unknown + errorCode`，继续使用 exact key whitelist；任何额外 `message`、raw provider body 或自由 metadata 均为 InconsistentFields。
- `just test -p crewon-artifact`：10/10 Green。
- `just test -p crewon-state`：199/199 Green。
- 最终 `just fix -p crewon-artifact`、`just fix -p crewon-state` 与 `just fmt` Green；按仓库规则之后未重跑测试。
- W2-05 后续 P3b-P3d 已完成 0046 Dynamic Tool journal 与原子 Audit transaction；ExternalAction 的 succeeded/failed/unknown 由 State 逐字段关联并通过 restart/concurrency/tamper Harness。W1-09 通用 Artifact/Audit schema 未增加 raw error 或 payload 字段。
