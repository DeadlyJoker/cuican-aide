# W2-03 Implementation Plan

## Stage 0: W2-02C prerequisite（已完成）

1. 在 Agent Platform 先完成 signed discovery authority 和 Provider v3 descriptor/resource API。
2. 用 pytest 临时数据库、fake Permission 和 strict HTTP app 验证 exact revision、权限、分页、digest 与 token mix-up。
3. W2-02 verification 已记录 210 项 Provider 回归、3 项 Permission 回归和跨仓双契约校验；Gate 已通过。

## Stage A: Provider transport extraction（已完成）

1. 已新建 `crewon-provider-transport` 并迁移原有 7 项行为 Harness。
2. endpoint policy、resolver port、validated endpoint、pinned client 和 bounded response reader 已成为单一 crate authority。
3. app-server Wave 1 gate 直接使用新 crate；原私有 policy/guard 文件和模块声明已删除，没有兼容 facade。
4. SSRF/error matrix、1014 项 app-server 回归、依赖边界和 Bazel lock 均通过。

此阶段以机械迁移为主，可超过普通复杂逻辑行数阈值，但行为变更必须为零；若出现行为修复，拆成独立 review stage。

## Stage B: Agent Platform discovery wire and auth ports（已完成）

1. 已在 `crewon-provider-agent-platform` 定义 discovery strict bounded DTO、closed capabilities/error boundary。
2. 已定义带文档的 authorization port；service/delegation token 使用 zeroizing、sensitive header 与 redacted Debug，不能 Serialize 或公开读取。
3. 已建立 canonical discovery fixture equality、未知字段/capability、重复 capability、request body redaction Harness。

## Stage C: Catalog and Run client

1. [x] 实现 descriptor/capability read 与 `CatalogProvider` list/read mapping。
2. [x] 实现 durable Run start/read/events/cancel，并对每次调用执行 exact Resource/task/Credential authorization binding。
3. [x] 实现 bounded body、status/error/Retry-After/cursor/event validation；不实现 retry 或 Task mapping。
4. [x] 审计 approval/tool-result capability：production descriptor 和 HTTP route 均未暴露，当前 adapter 不提供伪 mutation API，未声明的对应事件 fail-closed；后续能力扩展必须独立 amendment。

## Stage D: Verification

1. [x] 运行两个 crate 的 package tests 与依赖边界扫描。
2. [x] Rust dependency 变化后运行 `just bazel-lock-update` 和 `just bazel-lock-check`。
3. [x] 运行 scoped `just fix -p`；最后 `just fmt`，之后不重跑测试。
4. [x] 更新 verification：W2-04/W2-07 解锁，W2-08 仍等待 W2-04 至 W2-07；未做 production cutover。
