# W2-04RC Specification: Live Provider Resource Catalog

状态：E2 Green。app-server 私有 live catalog session、共享 connection authority 双检、resource list/read runtime，以及 experimental `resource/list` / `resource/read` v2 RPC 已落地；不实现 Resource Binding，不接 UI。

## 1. 已确认事实

- `crewon-provider-agent-platform::AgentPlatformProviderClient` 已实现 `CatalogProvider`，能在同一 pinned/authenticated client 上读取 strict descriptor、cursor-paginated exact ResourceRef 和 exact ResourceManifest。
- Agent Platform catalog 当前只支持 `ResourceKind::Agent`，Provider page limit 最多 50；resource-federation 公共 page 上限为 100，cursor、ID、revision、schema version 和 digest 都有硬上限。
- app-server production factory 当前只实现 `ProviderDescriptorReader`。它在每次读取时创建 catalog client、取 descriptor 后立即丢弃 client。
- 先调用现有 `provider/read`，再为 resource/list/read 创建第二个 catalog client，会重复 descriptor I/O，也无法复用同一个 live descriptor/session；这不是终态实现。
- protocol 已有 authority-free `ResourceListParams/Response` 和 `ResourceReadParams/Response` DTO，但尚无 `resource/list`、`resource/read` 方法注册。

## 2. 最小正确边界

E1 新增 app-server 私有 catalog port：

- `ProviderResourceCatalogFactory` 只接受 server-owned Provider authorization identity，连接一次并返回 catalog session；
- `ProviderResourceCatalog` 暴露该 session 已验证的 `LiveProviderDescriptor`、bounded list 和 exact manifest read；
- production wrapper 复用现有 pinned connector、RS256 authorizer 和 `AgentPlatformProviderClient`，不复制 HTTP、endpoint、auth 或 wire mapping；
- fake implementation 仅用于独立 Harness。

connection access 被拆为共享的 begin/finish 校验：

1. begin 校验 connectionId、读取 persisted connection、按 actor/tenant/space 隔离 owner、解析 current fresh mapping + active grant，并要求 connection 的 provider/grant exact 匹配；
2. catalog connect 读取一次 strict descriptor，并要求 providerId/protocolVersion 与 persisted connection exact 匹配；
3. 执行 list 或 exact read；
4. finish 在 Provider I/O 后重新读取时间、mapping 与 grant，要求 authority 与 begin 完全一致；
5. 只在 finish 成功后生成 Resource response 和基于同一 live descriptor 的 provider ETag。

begin/finish 不持有数据库锁跨越外部 I/O，也不把 authority snapshot 当成可持久化授权。现有 provider/read 必须复用相同校验边界，避免 Resource processor 复制 owner/grant 判断。

## 3. Resource 输入与投影

- list 默认 limit 20；客户端 limit 必须在 1..=100，Provider 可以按自身已声明上限返回更小页面；nextCursor 保持 opaque。
- list filter 只映射 closed `ResourceType`。当前 Agent Platform 对非 Agent kind fail-closed，不伪造空页面或兼容降级。
- read 的 protocol `ResourceRef` 不包含 protocolVersion；app-server 必须从已验证 connection record 构造 domain ProviderRef。客户端 resource.providerId 必须等于 connection providerId。
- read 必须保持 exact resourceId/revision/type，不允许 latest、compatible revision 或 provider substitution。
- list/read projection 只返回 providerId、resourceId、revision、resourceType、schemaVersion、可选 contentDigest、nextCursor 和 providerEtag；不含 endpoint、owner、grant、credential、scope、workspace 或 manifest body。

## 4. 错误与安全

- malformed connection/cursor/limit/resource 输入映射为 invalid params；
- cross-owner connection 继续映射为 not found，避免资源存在性侧漏；
- grant/mapping drift 或 revoke 映射为 unauthorized；
- Provider unauthorized/not-found/incompatible/unavailable/invalid-response 使用稳定闭集，禁止回显外部 body、URL、identity 或 Secret；
- 未配置 runtime 继续 fail-closed，不回退旧 Agent Platform Open API token/cwd 路径；
- 不注入模型上下文，不修改 rollout/session resume，不新增配置键或依赖。

## 5. Harness 与停止条件

E1 Harness 覆盖：

- 单次 catalog connect 后 list/read 使用同一 descriptor/session，不重复 descriptor read；
- list limit/cursor/kind、exact ResourceRef/manifest projection 与 provider ETag；
- malformed input、cross-owner、protocol drift、Provider error、I/O 中 grant revoke/mapping drift；
- response/Debug/error 不含 owner、grant、source、endpoint、token 或 workspace；
- production wiremock 路径继续通过 pinned RS256 connector，而不是 fake HTTP。

E1 没有注册 `resource/list/read`。共享 begin/finish 抽取保持了现有 provider/read 的语义和 error mapping，并由原有 processor Harness 回归。E2 已在独立评审切片中注册 experimental RPC、方法级 schema 与 TestAppServer；Resource Binding、projection notification、UI 和执行链仍不得越过各自后续 Gate。
