# W1-07 Specification: Typed Context 与 Memory Governance

## 1. 目标

建立可供 Single、Experts 和 Office 后续组合使用的有界 Typed Context 基座。每个新增模型可见片段必须在 `crewon-core/context` 中定义 struct、实现 `ContextualUserFragment`，并携带 provenance、trust、sensitivity、server-derived workspace binding、purpose、budget 和 freshness。

本 Wave 不切换旧 Office Prompt Authority，不扩展 app-server v2 `additionalContext` wire，也不建立新 Memory Store。统一接线由 W1-10/W3 完成。

## 2. 当前边界

- Core `AdditionalContextStore` 已按稳定 key 增量注入，重复值不会在下一 Turn 再追加。
- 现有 `AdditionalContextEntry` 只有 `Application/Untrusted + String`；它不能证明 workspace scope、来源、用途、敏感级别或新鲜度。
- `Application` 由 app-server 内部路径使用；W1-07 不允许 Tool、Provider、Knowledge、Memory 或 Workspace file 输出升级为 developer role。
- 旧 Office manager/member Prompt 和 `.crewon/office-memory/index.json` 保持现状；本 Wave 只提供未来原子迁移目标。

## 3. 模型

### 3.1 Audience

闭集：

- `Single`
- `Experts`
- `OfficeShared`
- `OfficeMemberPrivate`

Audience 必须包含 opaque `workspaceBindingId` 和 `scopeId`；Office member private 还必须包含 `memberId`。Context 不携带 canonical path。相同路径的 Single、Experts、Office 必须由 W1-02 产生不同 binding identity，fragment key 也必须不同。

### 3.2 Provenance 与 Trust

来源闭集：`Application`、`User`、`Tool`、`Provider`、`Knowledge`、`Memory`、`WorkspaceFile`。

- 只有 `Application` 可以声明 `TrustedApplication` 并渲染为 developer role。
- User/Tool/Provider/Knowledge/Memory/WorkspaceFile 固定为 `UntrustedData` 并渲染为 user role。
- provenance 包含 bounded source ID 和 server-derived actor ID；不得包含 Secret、绝对路径或 Provider raw body。

### 3.3 Sensitivity

模型可见闭集：`Public`、`Internal`、`WorkspaceSensitive`。`Secret` 必须在建 fragment 时拒绝，不能依赖 Prompt 提醒做脱敏。

### 3.4 Purpose

第一版只保留当前消费者所需：`TaskInput`、`Coordination`、`MemoryRetrieval`、`ToolResult`、`ResourceContext`。

### 3.5 Budget 与 Freshness

- 单 fragment token cap：128..900 approximate tokens；因此不会跨越 1K P0 阈值，也远低于 10K 总规则。
- Bundle 最多 8 fragments、总计最多 4K approximate tokens。
- Memory retrieval 最多 6 fragments。
- 超长 content 在构建时确定性 middle truncation，Manifest 记录原始 approximate token count；不会把无限文本交给 generic context 再二次猜测。
- `observedAt <= buildNow`；可选 `expiresAt >= observedAt` 且 `expiresAt >= buildNow`。过期片段 fail-closed。

## 4. 渲染和增量语义

- `GovernedContextFragment` 输出固定 marker 和 JSON body，Manifest 与 content 同时有界。
- trusted application 使用 developer role；其余均使用 user role。
- Bundle 使用稳定、scope-aware BTreeMap key 进入现有 AdditionalContextStore；相同 Bundle 的后续 Turn 不重复追加，不重写旧历史。
- Bundle 中所有 fragments 必须属于完全相同 Audience；跨 Audience 混合直接拒绝。

## 5. app-server Adapter

在 `platform_control` 下建立未接线 adapter：

- 从 W1-01 `RequestIdentity` 读取 actor。
- 从 W1-02 `WorkspaceRef` 读取 opaque binding/scope，绝不读取 path。
- Conversation binding 只能生成 Single/Experts audience；Office binding 只能生成 OfficeShared/OfficeMemberPrivate audience。
- Adapter 只构建 validated fragment；W1-10 才能把它接入业务 Processor。

## 6. 非目标

- 修改旧 Office manager/member Prompt 或 Memory index。
- 新增数据库、向量检索、embedding、Context Export 或 Tool Bridge。
- 把 Tool/Provider 输出变成 system/developer instruction。
- 修改 app-server v2 wire 或允许客户端声明治理元数据。
- 无限历史、无限检索、动态 Context provider registry。

## 7. 验收

1. Unit Harness 覆盖来源/trust、Secret、freshness、预算、memory 数量、Audience 混合和 stable key。
2. app-server adapter Harness 覆盖 RequestIdentity/Workspace scope 映射和 Single/Experts/Office 隔离。
3. Core suite 使用 `mount_sse_once` 捕获真实 ResponsesRequest，证明 role、截断、稳定顺序和连续 Turn 不重复注入。
4. targeted core/app-server tests 通过；完整 workspace `just test` 仍需用户批准。
