# W0-02 验证记录

状态：完成

## 当前证据

- <code>_verify_api_key</code> 已返回数据库 SpaceAPIKey，包括 spaceId、scopes、status 和 expiresAt。
- <code>_get_public_agent</code> 当前未接收 API Key，也未按 Agent.spaceId 过滤。
- info、chat、chat/stream 均依赖上述同一查询函数。
- Agent Platform 工作树中的现有未提交改动不包含本任务目标文件。

## Harness Red

命令：

<code>uv run --frozen pytest tests/test_agent_open_api_authorization.py -q</code>

旧实现结果：3 failed。

- 跨 Space info 返回 200，而不是 404。
- 空 scopes 和 execute-only Key 可以读取 info。
- read-only Key 可以执行 chat/chat-stream。
- 跨 Space Key 可以执行 chat/chat-stream。

失败发生在生产实现修改前，证明 Harness 能复现授权缺口。

## Harness Green

同一命令修改后结果：3 passed。

覆盖：

- 同 Space + agent:read 读取 info。
- 同 Space + agent:execute 执行 chat 和 chat/stream。
- 双向跨 Space 访问三个入口均返回 404。
- 未启用 Agent、缺失 Agent 和跨 Space Agent 返回相同 JSON 外观。
- 空 scopes、错误 scope 返回 403。
- revoked/expired Key 返回 401。
- deny 路径不会进入 AgentRuntime；成功路径分别只调用一次 run/run_stream。

目标 lint：

<code>uv run --frozen ruff check --select F,I app/api/v1/agent_open_api.py tests/test_agent_open_api_authorization.py</code>

结果：通过。

完整 ruff check 会报告该历史文件已有的 B008、UP041、UP045、B904 等存量问题；本任务没有扩大范围去机械重写整个 Open API 文件。

## Breaking-change 审核

- app-server API：无变化。
- Agent Platform URL、请求体和成功响应：无变化。
- Agent Platform 错误行为：apiEnabled=false 从 403 收敛为 404；跨 Space 从可访问变为 404。
- API Key：空 scopes 不再等价于全权限；info 需要 agent:read，chat/chat-stream 需要 agent:execute，通配 scope 继续可用。
- CLI 参数、配置加载、会话恢复：无变化。
- 迁移方式：为仍需调用的历史 Key 显式补充 scopes；不得恢复空 scopes 全放行。

调用点搜索确认 <code>_verify_api_key</code> 只用于 info、chat、chat/stream，三个入口都调用带 Space 和 scope 的 <code>_get_public_agent</code>。

## 未验证

- 未运行 Agent Platform 全量 pytest；当前改动使用目标集成 Harness 验证。
- 线上历史 API Key 的 scopes 分布尚未统计；安全策略按 fail-closed 落地，不用该未知项放宽授权。
- pytest 输出包含仓库既有 Pydantic/datetime deprecation warnings，不属于本任务授权缺口。
