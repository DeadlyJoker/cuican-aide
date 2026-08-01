# W1-08 Verification

状态：实现、targeted Harness、Bazel lock、scoped fix 与 final fmt 完成；尚未接入中心执行链。

## Current-path findings

- Core command/file/permissions approval 属于 Thread/Turn 内部执行交互，不是跨消费者 Action authorization。
- `office/approval/decide` 只修改客户端提供的 JSON `decision`，没有 ActionDigest、owner、Workspace、expiry、nonce 或 consume-once 语义。
- W1-08 没有修改这些旧入口，也没有创建 fallback；迁移与删除分别属于 W1-10/W3。

## Security and correctness matrix

| Case | Expected | Evidence |
| --- | --- | --- |
| canonical fixture | stable canonical JSON + SHA-256 | `action_digest_matches_stable_canonical_fixture`; digest `sha256:48aa00358a799dd9d2056c387b187d6785fe861b1d02ca35b34043858fb25990` |
| actor/tenant/space mutation | digest mismatch | `every_bound_field_mutation_invalidates_the_digest` |
| purpose mutation | digest mismatch | 同上 |
| workspace key/binding/scope/scopeId/node/environment mutation | digest mismatch | 同上 |
| Tool identity/revision、Provider protocol revision | digest mismatch | 同上 |
| Provider/Credential provider mismatch | construction rejected | `invalid_semantic_combinations_and_unbounded_arguments_fail_closed` |
| JSON object key reorder | same arguments hash | `arguments_hash_is_canonical_but_preserves_json_value_and_array_semantics` |
| JSON value/array order change | different arguments hash | 同上 |
| arguments over 256 KiB、depth 32、nodes 4096 | construction rejected | bounds implementation + oversized Harness |
| Credential id/revision/status/expiry/binding mutation | mismatch or deny | mutation Harness + `credential_rotation_invalidates_approval_and_revocation_is_denied` |
| executionLocation/sideEffect/expiry/nonce mutation | digest mismatch | mutation Harness |
| expired action/approval | deny/expired | baseline + ledger expiry Harness |
| nonce replay | reject | `nonce_replay_conflicting_decisions_and_expiry_fail_closed` |
| owner mismatch | reject | `approval_is_bound_to_owner_current_action_and_single_consumption` |
| Workspace mutation before consume | reject | 同上 |
| duplicate approval request/decision | idempotent | 同上 |
| duplicate consume/result | second authorization unavailable；side-effect counter remains 1 | 同上；ExecutionAuthorization is move-only and non-serializable |
| serialize/restart | consumed and nonce fences preserved | `snapshot_restore_preserves_nonce_and_consumption_fences` |
| impossible/unbounded snapshot | deserialize/restore reject | `snapshot_deserialization_and_restore_reject_unbounded_or_impossible_state` |
| server authority | actor/Workspace come from RequestIdentity/WorkspaceRef；declared client/session/trace fields excluded | app-server policy adapter Harness |
| Provider authority | CrewON decision is audit/local gate only | ExecutionAuthorization docs；没有 Provider authorization replacement |
| Approval audit correlation | immediate authorization -> none；consumed approval -> exact approvalId | `baseline_policy_returns_only_allow_deny_or_approval_required`、`approval_is_bound_to_owner_current_action_and_single_consumption` |

## Bounds and data minimization

- Action identifiers/purpose 均为 bounded opaque values；路径分隔符、空白和 control characters 被拒绝。
- Raw arguments 只在构造时计算 canonical hash，不进入 ActionIntent、Approval record 或 snapshot。
- Approval Ledger 最多 4096 records；snapshot 使用 bounded sequence visitor，避免先无界分配再检查。
- Snapshot 只含 actor、安全引用、digest、nonce、状态和时间，不含 Secret、Credential value 或原始 Tool payload。
- Production modules 为 478、435、185、232、115 LoC，均低于 500 LoC；大 change 按 `plan.md` 的五个 review slices 合并。

## Commands

- Harness red：首次 `just test -p crewon-policy` 因 action/approval/decision modules 尚不存在而失败。
- Fixture red：实现后 6/7 passed，stable fixture 捕获真实 canonical payload；修正 `tool_id` 为 camelCase `toolId` 后锁定 digest。
- Final `just test -p crewon-policy`: 10 passed, 0 skipped。
- Final `just test -p crewon-app-server policy_adapter`: 2 passed, 1015 skipped。
- `just bazel-lock-update`: passed；只有仓库既有 well-known crate annotation warnings。
- `just bazel-lock-check`: passed。
- `just fix -p crewon-policy`: passed，无 warning。
- `just fix -p crewon-app-server`: passed；保留 5 条旧 Office/Agent Platform processor warning，本任务新增代码无 warning。
- `just fmt`: passed。
- `git diff --check`: passed。

## Source and Authority review

- `crewon_policy` / `policy_adapter` 只出现在新 crate 与 `platform_control` adapter/tests；中心 `message_processor`、旧 Office processor 和 Core 未引用。
- 没有 v2 RPC、schema、Config、database 或 rollout shape 变化。
- `deny` 和 `approvalRequired` 不返回 ExecutionAuthorization；mutating side effect 永远先进入 approvalRequired。
- ExecutionAuthorization 不实现 Clone/Serialize，验证按 move 语义消费；实际 Provider 仍必须使用自己的授权和幂等机制。
- W2-05 consumer review 补齐了 exact approvalId：authorization 仍不可由 UI 构造，且只在 ApprovalLedger 成功 consume 后携带对应 ID；不使用 accessDecisionId 反推 Approval。
- 没有 UI decision、自然语言摘要、client actor/workspace 或 Credential Secret 进入授权事实。

## Not run / remaining boundary

- 完整 Rust workspace `just test` 未运行：按 AGENTS.md，完整 Core/common/protocol suite 需要用户明确批准；本任务没有修改这些共享协议。
- `argument-comment-lint` targeted wrapper 未运行：本机缺少 DotSlash，source wrapper 又缺少 `cargo-dylint`/`dylint-link`；新增本 crate 内部 numeric callsites 已按 `/*param_name*/` 规则人工补齐。
- W1-08 尚未持久化到 Authority Store、注册 approval RPC 或切换消费者；这些是 W1-10/W2/W3 的显式 composition/cutover 工作，不是旧路径 fallback。
