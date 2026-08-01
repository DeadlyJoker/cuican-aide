# W0-02 实施计划

## 文件所有权

- Agent Platform：<code>backend/app/api/v1/agent_open_api.py</code>
- Agent Platform：<code>backend/tests/test_agent_open_api_authorization.py</code>
- CrewON：本目录四个 SDD 文件

现有 <code>agent_runtime.py</code>、<code>llm_service.py</code> 和 <code>test_llm_streaming.py</code> 属于用户已有改动，本任务不修改。

## 顺序

1. 写集成 Harness，先复现跨 Space info/chat/chat-stream 可达和空 scope 被放行。
2. 运行目标 pytest，保存失败证据。
3. 将 scope 校验变成显式 fail-closed。
4. 将 Agent 查询绑定 apiKey.spaceId，并把不可访问资源统一为 404。
5. 重跑目标 pytest。
6. 搜索所有 Agent Open API 入口，确认都经过相同依赖和查询函数。
7. 运行 Python formatter/目标静态检查（若仓库已有命令）。
8. 更新 verification.md。

## 风险

- scope 收紧会使历史空 scopes Key 失效；这是预期安全变化，不做静默兼容。
- apiEnabled=false 的 403 变为 404；这是防资源枚举的必要变化。
- 不能用 AgentRuntime 成功执行作为授权证明；Harness 必须在进入 Runtime 前验证 deny，在成功路径使用 stub。

## 回滚边界

若出现兼容问题，可以停止新流量并为 Key 补显式 scopes；不得恢复跨 Space 查询或把空 scopes 视为全权限。
