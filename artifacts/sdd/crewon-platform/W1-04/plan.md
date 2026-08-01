# W1-04 Implementation Plan

## Stage A: Contract and bounded model

1. 新建 `codex-rs/resource-federation/`，只依赖 `serde`。
2. 定义 bounded ID/revision/schema/digest 类型、核心资源闭集、Provider/Resource/Manifest 模型。
3. 定义 `BindingMode`、`ExecutionLocation`、`Capability`、物化证明与请求/结果对象。
4. 所有公共构造路径执行校验；serde 反序列化不能绕过字符串、集合和页大小上限。

Review 边界：领域模型不接 wire DTO、app-server、Agent Platform 或 UI；无 HTTP/DB 依赖。

## Stage B: Harness-first resolver

1. 先建立表驱动测试，覆盖四种合法绑定的完整结果对象。
2. 建立拒绝矩阵：资源/版本不匹配、模式/位置冲突、capability 缺失、snapshot/fork provenance 错误、远程夹带物化。
3. 实现固定顺序、无 I/O 的 `resolve_binding`，错误使用有限枚举。
4. 添加未知 capability/字段 JSON fail-closed 测试。

Review 边界：复杂解析逻辑单独评审，保持实现小于 500 LoC；不提前实现下载器或访问控制。

## Stage C: Provider port and wiring

1. 定义 `CatalogProvider` RPITIT port、bounded list query/page 和有限 Provider error。
2. 只添加 workspace/Cargo/Bazel 构建接线，使 crate 可独立测试；不接入 app-server composition。
3. 运行 targeted tests、依赖边界检查、Bazel lock update/check、scoped fix，最后 fmt。

## 后续 cutover

- W1-10 composition 将 domain 类型映射到 app-server v2 DTO。
- W2 Agent Platform adapter 将 catalog/install/run API 映射到 `CatalogProvider` 与 Provider Run port。
- UI `downloaded` 字段只保留为旧 Provider catalog 展示状态，直到新 binding API 完成后一次性删除旧推断路径。

