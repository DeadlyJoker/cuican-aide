# W1-08 Implementation Plan

## 1. 依赖

- W1-01 `RequestIdentity`
- W1-02 `WorkspaceRef` / Registry
- W1-03 Credential lifecycle 与 revision/status 语义
- W1-04 exact Resource Binding revision
- W1-07 bounded, scoped context boundary

## 2. 实施顺序

1. 建立 canonical Action fixture 和会失败的 mutation/replay Harness。
2. 新建 `crewon-policy`，实现 bounded action types、canonical arguments hash 和 ActionDigest。
3. 实现 secure baseline `PolicyDecision` 与不可直接构造的 `ExecutionAuthorization`。
4. 实现 bounded Approval Ledger、幂等 request/decide/consume、snapshot/restore。
5. 在 `app-server/src/platform_control/` 增加 server-derived adapter 和目标测试，不注册 RPC。
6. 更新 Cargo/Bazel lock，运行 targeted tests、scoped fix 和最终 fmt。

## 3. 文件边界

- `codex-rs/policy/src/action.rs`：ActionIntent、canonical encoding/hash、bounded values。
- `codex-rs/policy/src/decision.rs`：PolicyDecision 与 ExecutionAuthorization。
- `codex-rs/policy/src/approval.rs`：Approval Ledger、snapshot/restore、单次消费。
- sibling `*_tests.rs`：Harness，不向生产文件加入 test-only helper。
- `codex-rs/app-server/src/platform_control/policy_adapter.rs`：服务端 Identity/Workspace 映射。

生产模块目标均低于 500 LoC；如果单模块接近上限，先拆分而不是扩展中心 processor。

## 4. 风险与回滚边界

- 新 crate 和 adapter 尚未接入执行主链，失败不会改变现有用户行为。
- 不双写旧 Office approval，不添加 silent fallback。
- 如果完整 digest 输入缺失，adapter 返回错误，不创建部分 digest。
- W1-10 接线前可整体移除新模块；接线后必须由单一 Gate 产生执行授权。

## 5. Review Gate

- Canonical encoding 和逐字段 mutation 单独 review。
- Approval 状态机、snapshot restore 和 replay protection 单独 review。
- app-server adapter 必须证明没有 Client-controlled actor/workspace。
- Source scan 证明没有旧 processor 调用新模块，也没有 Secret/raw arguments 进入 snapshot。

## 6. Merge staging

W1-08 的完整 Harness 超过单个 review slice 的 800 行目标，因此实际合并时按依赖拆为以下连续提交，不把它们压成一个大提交：

1. W1-08A：bounded Action model、canonical arguments hash、stable digest fixture。
2. W1-08B：逐字段 mutation、size/depth/node limits 与 relational validation Harness。
3. W1-08C：Baseline Policy、move-only ExecutionAuthorization、app-server server-derived adapter。
4. W1-08D：Approval request/decide/consume、nonce/owner/digest fence。
5. W1-08E：bounded snapshot deserialize、restore validation 与 restart/idempotency Harness。
6. W1-08F：消费者驱动的 additive amendment；move-only ExecutionAuthorization 保留 consumed approvalId，供 W1-09 metadata-only ApprovalCorrelation 使用。

当前工作树保留全部连续切片以便整体验证；未自动创建 commit，避免替用户决定提交边界。
