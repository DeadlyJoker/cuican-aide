# W1-04 Specification: Resource Federation 纯领域

## 1. 目标

本阶段建立最小 `crewon-resource-federation` 领域 crate，使本地 Agent、云 Agent、Skill、MCP、知识库和 Workflow 使用同一套可验证的资源引用与绑定语义。

本阶段解决的是“资源是什么、精确绑定到哪个版本、在哪里执行、Provider 是否明确允许”四个问题。它不下载资源、不发起网络请求、不持久化记录、不执行 Agent/Tool，也不改变现有 UI 或 Agent Platform API。

## 2. 现状与迁移边界

- app-server v2 canonical contract 已有 `ResourceRef`、`ResourceBindingMode` 和 `ExecutionLocation` 的 wire vocabulary，但尚无拥有解析规则的纯领域实现。
- Agent Platform 当前 `downloaded` 表示账号侧存在安装/下载记录，Skill archive 也由 Agent Platform 服务端保存。该布尔值不是 CrewON 的执行位置、绑定模式或本地物化证明。
- CrewON UI 暂时仍读取 Agent Platform 的 `downloaded` 字段。本阶段不改 UI；后续 adapter/cutover 必须把该字段映射为 Provider 侧状态，不能继续用它推断 CrewON Runtime 语义。
- W0-03 已定义 Durable Provider Run 契约。本 crate 不重复定义 run/event/approval capability，只定义资源绑定 capability。

## 3. 最小模型

### 3.1 稳定核心资源类型

首版只支持当前已有消费者需要的闭集：

- `Agent`
- `Skill`
- `McpServer`
- `McpTool`
- `KnowledgeBase`
- `Workflow`

不提供任意字符串扩展类型、Application 或 Provider 专属 dataset 类型。未来只有出现真实消费者和兼容策略时才扩展核心枚举或在 adapter 边界新增显式版本化类型。

### 3.2 引用与版本

- `ProviderRef` 只包含 bounded opaque Provider ID 和 Provider protocol version。
- `ResourceRef` 包含 Provider、资源类型、opaque resource ID 和精确 `ResourceRevision`。
- 首版只允许精确 revision；不提供 `latest`、`latestCompatible` 或 semver 猜测。
- ID、revision、schema version、cursor 等字符串均非空、有字节硬上限，反序列化不能绕过校验。
- Snapshot/Fork 来源校验使用 canonical `sha256:<64 lowercase hex>` digest。

### 3.3 三个独立概念

- 资源发现位置由 `ProviderRef` 表达：资源属于哪个 Provider catalog。
- `BindingMode` 表达 CrewON 如何持有资源：`RemoteReference | LocalSnapshot | LocalFork | ProviderManaged`。
- `ExecutionLocation` 表达实际执行位置：`LocalNode | Provider`。

固定允许矩阵：

| BindingMode | ExecutionLocation | 物化要求 |
| --- | --- | --- |
| RemoteReference | Provider | 禁止本地物化 |
| ProviderManaged | Provider | 禁止本地物化 |
| LocalSnapshot | LocalNode | 必须有与来源 revision/digest 完全一致的不可变物化 |
| LocalFork | LocalNode | 必须保留与来源 revision/digest 一致的 provenance；本地 revision/digest 可不同 |

任何其他组合直接拒绝，不根据文件存在、名称前缀或 `downloaded` 猜测。

### 3.4 Capability

`Capability` 是 Provider 明确声明的三元组：

```text
(ResourceKind, BindingMode, ExecutionLocation)
```

解析时必须存在完全匹配的 capability。未知 enum 值、未知字段、超过数量上限或缺少匹配项均 fail-closed。Capability 不携带 HTTP endpoint、Token、Agent Platform 字段或动态 handler。

### 3.5 Manifest 与绑定结果

- `ResourceManifest` 固定资源精确引用、manifest schema version 和可选 content digest。
- `BindingRequest` 固定 binding/workspace、资源精确引用、模式、执行位置与可选本地物化证明。
- `ResolvedResourceBinding` 是通过全部校验后的不可变值，保存 manifest schema version、匹配 capability 和物化证明，供后续 Task Contract 固定引用。
- Provider 资源 revision 与请求 revision 不一致时失败；Run 中不得自动升级。

## 4. 解析顺序

纯函数 `resolve_binding` 按固定顺序执行：

1. 校验 manifest 与请求是否属于同一 Provider、资源类型和资源 ID。
2. 校验请求精确 revision 与 manifest revision 一致。
3. 校验 capability snapshot 属于同一 Provider。
4. 校验 BindingMode 与 ExecutionLocation 固定矩阵。
5. 校验 Provider 存在完全匹配的 capability。
6. 对远程模式拒绝本地物化；对本地模式验证 manifest digest 和物化 provenance。
7. 生成完整 `ResolvedResourceBinding`。

任一步失败均不返回部分结果。

## 5. Provider port

`CatalogProvider` 只定义两个 RPITIT 异步端口：

- 分页列出 versioned `ResourceRef`。
- 读取某个精确 `ResourceRef` 的 `ResourceManifest`。

Port 的错误是有限闭集，不携带 Provider 原始响应。HTTP、认证、重试、访问控制、下载、签名扫描和缓存由后续 adapter/composition 负责。

## 6. 安全与正确性不变量

1. 未知资源类型、绑定模式、执行位置和 capability 反序列化失败。
2. 所有集合和字符串有硬上限；单个 Provider capability 不得无限增长。
3. `LocalSnapshot` 必须证明来源 revision/digest 与本地 revision/digest 完全一致。
4. `LocalFork` 必须证明来源 revision/digest 一致，且明确固定本地 revision/digest。
5. 远程绑定不能夹带本地物化对象。
6. Resolver 不做 I/O，不读取环境变量，不接受 Credential Secret。
7. crate 不依赖 `reqwest`、`sqlx`、`crewon-app-server` 或 `crewon-core`。

## 7. 非目标

- 本地 bundle 下载、解压、扫描、缓存与垃圾回收。
- Provider HTTP client、OAuth/API Key、Endpoint Policy composition。
- 动态多 Provider 插件 Registry。
- Task/Run/Worker 调度与 Provider durable run。
- UI catalog、标签、安装按钮或 `downloaded` 字段迁移。
- 数据库 schema、RPC 或 app-server composition。

## 8. 验收

- 表驱动 Harness 完整比较成功的 `ResolvedResourceBinding`。
- 覆盖 revision mismatch、capability conflict、execution location conflict、snapshot/fork 校验、远程夹带物化和未知 capability fail-closed。
- `just test -p crewon-resource-federation` 通过。
- Cargo 依赖边界扫描通过；workspace 依赖变化执行 Bazel lock update/check。
- public trait/type 有职责文档；核心 match exhaustive。

