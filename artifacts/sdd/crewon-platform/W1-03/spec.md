# W1-03 Specification: CredentialRef 与 Provider Endpoint Policy

## 1. 目标

本阶段建立两项平台基础能力：

1. 服务端拥有的 Credential 生命周期：调用方只持有 `CredentialRef`，Secret 只在受控 Store 与 Provider Adapter 的最短执行路径中出现。
2. Provider 出站端点策略：所有用户可配置或部署可配置的 Provider 地址在发起网络请求前统一完成 URL、DNS、地址、重定向、超时与响应大小校验。

本阶段不切换现有 Agent Platform、Account Auth 或 MCP OAuth 的权威路径；它们只作为后续迁移消费者。禁止双写、隐式 fallback 和浏览器持有服务 Secret。

## 2. 现状与复用边界

- `crewon-secrets` 已提供基于 OS Keyring 密钥和 age 加密文件的本地 Secret backend，应作为 Desktop Credential adapter 的底座。
- `crewon-keyring-store` 已提供 OS Keyring port，不新建第二套 keyring 抽象。
- Account Auth 与 MCP OAuth 已各自存在兼容存储；本阶段不改写其格式，后续在单独切换任务中迁移到统一 Credential authority。
- `AgentPlatformRequestProcessor` 当前从环境变量读取 Service API Key，并从客户端 Params 接收用户 access token；本阶段只记录为迁移面，不把旧 API 包装成新 Credential API。
- `CredentialRef` 已存在于 app-server v2 canonical contract，但缺少 scope 与 rotation revision。

## 3. Credential 领域约束

### 3.1 权威与引用

- `CredentialOwner` 由已认证 Session/Delegation 在服务端构造，包含 actor、tenant 和 space 边界；客户端不得提交 owner。
- `CredentialRef` 只暴露 opaque credential ID、provider ID、scope kind、可用状态、expiry 和 revision，不暴露 owner、Secret、Store key 或本地路径。
- Credential ID 使用高熵随机值，不编码 owner/provider/tenant 信息。
- provider ID、scope 和 granted scope 在创建后不可原地改变；需要改变授权边界时创建新 Credential。

### 3.2 生命周期

- `create`：校验 owner/provider/scope/granted scopes/expiry，持久化 revision 1。
- `read`：必须同时匹配 credential ID 与 server-derived owner；只在 Available 状态返回 Secret handle。
- `rotate`：保持 credential ID 与授权边界不变，替换 Secret、更新 expiry、revision 单调加一。
- `revoke`：幂等地进入 Revoked；撤销后不可 read 或 rotate。
- `inspect`：返回不含 Secret 的 metadata；Expired 由当前服务端时间与 expiry 动态计算。
- Store 缺失、损坏或不可访问时 fail-closed，不把原始 payload 放进错误。

### 3.3 上限

- provider ID、actor/tenant/space ID、scope 名称均有字节硬上限。
- granted scopes 有 item 数与单项字节硬上限，去重后持久化。
- Secret 有最小非空与最大字节限制；错误只报告类型，不回显内容。

### 3.4 Adapter

- `LocalCredentialStore`：复用 `SecretsBackend`；本地密文落盘，解密密钥保存在 OS Keyring；同一进程内串行化读改写。
- `FakeCredentialStore`：纯内存、确定性 ID，用于生命周期和 owner 隔离 Harness。
- Web Cloud Vault：本阶段只由 `CredentialStore` trait 定义 port，不提供浏览器实现；未来实现必须在服务端 Cloud Control 中完成。

## 4. Provider Endpoint Policy

### 4.1 默认规则

- Production 只允许 HTTPS。
- Development 只对解析结果全部为 loopback 的端点显式允许 HTTP。
- 禁止 URL username/password、fragment、空 host 和 metadata host。
- 每次初始请求与每个 redirect 都重新解析 DNS并重新做地址分类。
- 拒绝 loopback、private、link-local、unspecified、multicast、carrier-grade NAT、保留地址和 metadata 地址；Development loopback 例外不扩大到其他私网。
- DNS 结果为空或同时含有 public/forbidden 地址时 fail-closed。
- 自动 redirect 关闭；仅允许调用方通过 Policy 显式校验同 origin redirect，redirect 次数有硬上限。
- 返回的 validated endpoint 携带已解析 SocketAddr，HTTP client 必须 pin 到该集合，避免校验后再次解析产生 DNS rebinding TOCTOU。
- connect timeout、request timeout 和 response byte cap 由 Policy 统一提供；响应读取超过上限立即失败。

### 4.2 非目标

- 不实现任意 URL 代理。
- 不允许模型输出、Tool 参数或聊天正文成为 Provider base URL。
- 不在纯 Credential 领域模块发起网络请求。
- 不在本阶段切换现有 Agent Platform/MCP/Model Provider client。

## 5. API 契约

`CredentialRef` 增加：

- `scope`: `User | Space | Service`
- `revision`: 从 1 开始、轮换后递增

owner、granted scopes、rotation/revocation timestamp 和 Secret 保持服务端内部数据，不进入 canonical wire ref。

本阶段不新增 `credential/*` RPC；连接建立与 API composition 由后续 W1-10/W2 Provider Connection 任务完成。

## 6. 安全不变量

1. Secret 类型不实现 Serialize/Deserialize，Debug 固定为 redacted。
2. Credential metadata 的 Debug/Serialize 不含 Secret。
3. 错误、日志、snapshot 和 fixture 不出现测试 Secret 原文。
4. owner mismatch 与不存在对外均可映射为统一 NotFound；Store 内部错误不泄露记录内容。
5. Production policy 不能通过测试配置或环境变量放宽为任意 HTTP/私网。
6. Endpoint 校验结果必须与实际连接地址绑定，不能只验证 URL 字符串。

## 7. 验收

- `crewon-secrets` targeted tests 覆盖 create/read/rotate/revoke、owner mismatch、expiry、limits、Debug/Serialize/error redaction。
- `crewon-app-server` endpoint targeted tests 覆盖 HTTPS、HTTP、loopback/private/link-local/metadata、redirect、DNS rebinding、response cap 和 timeout。
- app-server protocol schema 与 TypeScript 生成物更新并通过 targeted tests。
- `verification.md` 记录 Secret 扫描、SSRF 矩阵、未切换消费者和剩余风险。

