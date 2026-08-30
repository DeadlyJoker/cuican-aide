# W1-09 Implementation Plan

## 1. 顺序

1. 建立 domain Harness：Secret/body redaction、refs、retention 和 audit metadata。
2. 实现 `crewon-artifact` 纯领域 crate。
3. 建立 State Harness 与 migration，先验证 restart/atomic/idempotency/delete/expiry。
4. 实现 State records/store，复用 `StateRuntime.pool` 和 migration lifecycle。
5. 实现 app-server server-derived adapter，不注册 RPC、不接旧 Office。
6. 运行 targeted tests、Bazel lock、scoped fix、final fmt 和数据扫描。

## 2. 文件边界

- `codex-rs/artifact/src/model.rs`：Artifact/Payload/Retention/Evidence/Citation。
- `codex-rs/artifact/src/audit.rs`：Audit/Trace/Cost/correlation。
- `codex-rs/state/migrations/0038_artifact_audit.sql`。
- `codex-rs/state/src/artifact_records.rs`：bounded persistence DTO。
- `codex-rs/state/src/runtime/artifacts.rs`：transaction/read/delete/prune。
- sibling/integration tests：不在生产文件放 test-only helper。
- `app-server/src/platform_control/artifact_adapter.rs`：领域到 State 的服务端映射。

## 3. 风险和回滚

- 新表只追加到既有 state DB；没有 consumer 前不会改变现有行为。
- migration 可由旧 binary 通过 ignore-missing 打开；不修改或删除旧表。
- create transaction 失败即 rollback；不使用文件系统与数据库双写。
- W1-10 前可移除 adapter/new tables without production cutover；接线后只允许 stable refs。

## 4. Review staging

完整任务预计超过单个 800-line review slice，合并时按依赖拆分：

1. W1-09A domain refs/manifest/retention + redaction Harness。
2. W1-09B Audit/Trace/Cost/Evidence/Citation + serialization Harness。
3. W1-09C State schema/records + atomic create/idempotency Harness。
4. W1-09D delete/expiry/restart + app-server adapter。
5. W1-09E consumer amendment：AuditOutcome::Unknown + State strict JSON schema/Harness，不与 Dynamic Tool journal migration 混成一个 review slice。

当前工作树可连续实现并整体验证，但不自动创建 commit。
