# W1-10 Implementation Plan

## 1. 顺序

1. 审计 W1-01 至 W1-09 的 verification、public API、持久化边界和依赖方向。
2. 只补 composition 缺口：Credential metadata 到 Policy binding、Artifact retention deletion 的服务端映射。
3. 建立单条 Wave 1 integration Harness，先验证 authority、bounds、revoke、digest、restart 和 retention。
4. 运行依赖边界检查，确认没有通过 app-server/core 形成反向依赖。
5. 运行 app-server 定向与 package 回归、Bazel lock update/check、scoped fix 和 final fmt。

## 2. 文件边界

- `codex-rs/app-server/src/platform_control/credential_adapter.rs`：Identity/Credential metadata 到 Policy reference 的最小映射。
- `codex-rs/app-server/src/platform_control/artifact_adapter.rs`：补充 server-derived retention deletion 映射。
- `codex-rs/app-server/src/platform_control/wave1_gate_tests.rs`：Wave 1 hermetic composition Harness。
- `codex-rs/app-server/Cargo.toml`：显式依赖 Wave 1 crate；不通过 transitive dependency 隐式取类型。
- 本目录 SDD：冻结 Gate contract 和真实验证证据。

不修改 app-server 中心 processor、旧 Office/Cloud Agent/Task production route、UI 或上游领域 public contract。

## 3. Harness 策略

- wire 层：真实 `TestAppServer` 验证 identity/workspace 的客户端伪造字段被拒绝。
- composition 层：服务端构造 `RequestIdentity` 与已绑定 `WorkspaceRef`，调用真实 adapter/domain/state port。
- external 层：Fake Catalog、deterministic Endpoint Resolver 和 fake Credential Store；禁止真实 HTTP/Agent execution。
- persistence 层：临时 `StateRuntime` close/reopen，验证 Task、Artifact、Audit、Retention tombstone。

## 4. 风险与回滚

- 新 adapter 在生产 consumer cutover 前保持内部、未注册 RPC，因此不改变现有用户路径。
- 若 Credential/Policy 或 Artifact/State 类型无法无损映射，应退回 W1-04/W1-08/W1-09，不在 app-server 增加宽松 JSON 或第二套状态。
- Harness 失败只修正测试数据与真实契约不一致或对应上游缺陷，不降低 fail-closed 条件。
- 回滚 W1-10 只需移除内部 adapter/Harness/Cargo direct dependency，不涉及数据迁移回滚。

## 5. Review staging

W1-10 是中心接线 Gate，生产改动保持小于 500 行；较长的 hermetic integration test 独立在 sibling test file。建议审查顺序：

1. Credential/Artifact adapter 的 authority 映射。
2. Integration Harness 的安全矩阵和 no-side-effect 证明。
3. Cargo/Bazel/依赖方向与 SDD verification。
