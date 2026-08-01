# W0-02 Agent Platform 跨空间授权修复规格

状态：实施中  
上位任务：<code>artifacts/crewon-platform-wave-sdd-execution-guide.md</code> W0-02

## 当前事实

- 对外入口位于 <code>agent-platform/backend/app/api/v1/agent_open_api.py</code>。
- Space API Key 验证只校验 key hash、active 和 expiresAt，返回绑定的 spaceId。
- Agent 查询当前只校验 agentId、isActive 和 apiEnabled，没有绑定 API Key 的 spaceId。
- info、chat、chat/stream 都调用同一不带 Space 条件的查询，因此任意有效 Space API Key 可以探测或执行其他 Space 的开放 Agent。
- SpaceAPIKey 已有 scopes；Agent 已有 spaceId，不需要新表或猜测归属。

## 目标与安全不变量

1. Space API Key 只能读取或执行同一 spaceId 的 Agent。
2. info 需要 <code>agent:read</code> 或通配 scope；chat、chat/stream 需要 <code>agent:execute</code> 或通配 scope。
3. Agent 不存在、跨 Space、未启用或已停用对调用方统一表现为 404，避免资源存在性泄漏。
4. 缺失、无效、撤销或过期 API Key 返回 401。
5. scope 不足返回 403，并且不能进入 AgentRuntime。
6. API Key 的 spaceId、status、expiresAt 和 scopes 只来自数据库记录，不接受请求覆盖。

## 范围

- 修改 Agent Open API 的 key scope 检查和 Agent 查询约束。
- 增加 hermetic pytest 集成测试，覆盖 info/chat/chat-stream 的授权矩阵。
- 保持现有 URL、请求体和成功响应形状。

## 非目标

- 不修改 AgentRuntime 模型循环。
- 不实现 Durable Provider Run。
- 不修改 Workflow Open API、Catalog 或 Space API Key 管理 UI。
- 不新增租户/Space 数据模型。

## 外部行为变化

- 过去可被其他 Space API Key 访问的 Agent 现在返回 404。
- apiEnabled=false 从 403 收敛为 404，避免泄漏资源存在。
- 空 scopes 不再等价于全权限；必须显式包含目标 scope 或通配 scope。

这些变化属于必要的安全收紧，不改变成功响应和路由，但需要在 breaking-change review 中记录。

## 验收标准

- 同 Space + agent:read 可以访问 info。
- 同 Space + agent:execute 可以访问 chat 和 chat/stream。
- 跨 Space 对三个入口均返回 404。
- scope 不足返回 403，AgentRuntime 未被调用。
- revoked/expired key 返回 401。
- 目标 pytest 文件通过，且未修改已有 AgentRuntime/LLM 未提交改动。
