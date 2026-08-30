# W1-04 Verification

状态：W1-04 scoped implementation 与 verification 完成；未接入 app-server、UI 或 Agent Platform adapter。

## Planned review stages

| Stage | 范围 | 状态 |
| --- | --- | --- |
| A | bounded model + provider port + build wiring | 通过；`model.rs` 417 LoC，`provider_port.rs` 171 LoC |
| B | resolver + table-driven Harness | 通过；218 + 463 LoC，逻辑 review stage 共 681 LoC |
| C | dependency boundary + workspace/Bazel lock | 通过；无 app-server composition |
| D | targeted test、Clippy、fmt、影响面检查 | 通过 |

按 change-size 规则，落地评审应拆成两个 coherent stage：

1. W1-04A：bounded model、CatalogProvider port、crate/build wiring。
2. W1-04B：binding resolver 与完整 Harness。

两个 stage 均低于 800 行 review 上限；复杂 resolver 实现低于 500 行。

## Planned rejection matrix

| Case | Expected |
| --- | --- |
| 请求 revision 与 manifest 不一致 | RevisionMismatch |
| BindingMode 与 ExecutionLocation 不允许 | ExecutionLocationNotAllowed |
| Provider 未声明精确 capability | CapabilityNotSupported |
| LocalSnapshot 缺 digest/物化 | fail-closed |
| Snapshot source/local digest 或 revision 不一致 | SnapshotVerificationFailed |
| LocalFork provenance 与来源不一致 | ForkProvenanceMismatch |
| RemoteReference/ProviderManaged 携带物化 | UnexpectedMaterialization |
| 未知 resource/mode/location/capability JSON | deserialize failure |

以上矩阵由 8 个 Harness tests 覆盖，合法场景比较完整 `ResolvedResourceBinding` 对象。`ResolvedResourceBinding` 对外不可直接构造或反序列化，`ResourcePage` 与 capability snapshot 的集合不能通过公开字段扩容绕过上限。

## Dependency boundary

允许：`serde`；测试允许 `serde_json`、`pretty_assertions`。

禁止：`reqwest`、`sqlx`、`crewon-app-server`、`crewon-core`、UI、Agent Platform 专属 crate。

自动检查：`resource-federation/scripts/check-dependency-boundary.sh` 已通过。

## Test and build evidence

- Harness red phase：新 crate 在领域模块缺失时按预期编译失败。
- `just test -p crewon-resource-federation`：8 passed，0 skipped。
- API 可见性收紧后 `just fix -p crewon-resource-federation` 编译全部 test target 并通过，无 warning。
- `just bazel-lock-update`：passed；`MODULE.bazel.lock` 无新增 drift。
- `just bazel-lock-check`：passed。
- `just fmt`：passed；按仓库规则未在 fix/fmt 后重复执行测试。

## Impact and deferred composition

- 修改仅包含新领域 crate、Cargo workspace/build wiring、Cargo.lock 和 W1-04 SDD。
- 没有修改 app-server protocol、processor、数据库、UI 或 Agent Platform。
- app-server v2 目前仍使用较粗粒度的 `Mcp`/`Knowledge` wire enum；W1-10 composition 前必须显式决定映射或升级为 `McpServer`/`McpTool`/`KnowledgeBase`，不得静默丢失类型信息。
- UI/Agent Platform 的 `downloaded` 仍是旧 catalog 状态；本阶段没有赋予其 Runtime 语义，也没有建立 fallback。
- 完整 Rust workspace test 未执行：此前 Wave 修改了 protocol，按仓库规则仍需用户明确批准；W1-04 自身未新增 common/core/protocol 依赖。
