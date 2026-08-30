# W0-03 验证记录

状态：完成

## Discovery

- Agent Platform 当前公开执行面是 chat/chat-stream，只有进程内并发控制，没有 durable run、稳定 cursor、cancel、approval/tool-result 生命周期。
- Agent Platform 已使用 Pydantic v2，CrewON app-server-protocol 已使用 serde/schemars/ts-rs 和 vendored schema fixture。
- 两仓没有可直接复用的共享源码发布渠道，因此采用 canonical source + generated distribution，而不是复制后各自维护。

## Harness Red

第一层先只接入测试：

- CrewON <code>just test -p crewon-app-server-protocol provider_contract</code> 因 <code>ProviderContract</code> 不存在而编译失败。
- Agent Platform <code>uv run --frozen pytest tests/test_provider_contract.py -q</code> 因 contract module 不存在而收集失败。

第二层补齐 strict models，但 canonical fixture 故意使用非法 <code>type: launch</code>：

- Rust 明确失败为 unknown variant，列出 start/read/listEvents/cancel/decideApproval/submitToolResult 合法 tag。
- Python 明确失败为 discriminated union tag invalid，合法 tag 与 Rust 一致。

这两次失败均发生在首版 fixture 写入前，证明双方不会吞掉未知 command/event。

## Harness Green

- Agent Platform active canonical：<code>contracts/provider/v3/provider_contract.v3.json</code>；v1/v2 仅保留历史证据。
- CrewON generated distribution 与 canonical 字节等值，SHA-256 均为 <code>30d3845484ef6ef74f88be7b570ab1c8023d704186c337983e6dd8658bb916a5</code>。
- <code>./scripts/verify-agent-platform-provider-contract.sh</code>：通过，校验字节等值和 provenance digest。
- <code>uv run --frozen pytest tests/test_agent_open_api_authorization.py tests/test_provider_contract.py -q</code>：13 passed。
- <code>uv run --frozen ruff check app/contracts/provider_contract.py tests/test_provider_contract.py</code>：通过。
- <code>uv run --frozen ruff check --select F,I app/api/v1/agent_open_api.py tests/test_agent_open_api_authorization.py</code>：通过。
- <code>just write-app-server-schema</code>：通过。
- <code>just test -p crewon-app-server-protocol</code>：237 passed，0 skipped，包括 JSON/TypeScript schema fixture equality。

双方 mutation Harness 均覆盖：缺字段、多字段、嵌套权威字段注入、rename、错误 union tag、required-nullable 缺失、未知错误码、capability 缺失和事件 sequence 乱序。

双方 invariant validation 还固定了 scope 集合、credential owner/subject、每种 command 恰好一个、单 run/attempt、连续 cursor、唯一末尾终态、delegation expiry、approval actionDigest，以及 `toolResultRequired.intentDigest -> submitToolResult -> toolResultAccepted` 闭环绑定。

## W2-02 v2 安全修订证据

- v1 无法结构化表达等待中的 Tool Intent，继续实现会迫使控制面从自由文本猜测 toolCallId；按原规格的 breaking-change 规则升 major 至 2.0.0。
- v2 新增 toolResultRequired，并在 submit/accepted 两侧加入 intentDigest；Rust/Python drift Harness 会拒绝 intentDigest 不一致。
- `./scripts/verify-agent-platform-provider-contract.sh`、Python contract tests 和 Rust 237 项 protocol tests 均通过。

## W2-02 v3 Task/Artifact 修订证据

- v2 无可信 taskId binding，且 contextRefs 为自由字符串，无法保证 output Artifact 归属或 exact context revision；按 breaking-change 规则在 production cutover 前升至 3.0.0。
- v3 authorization 增加 signed taskId，contextRefs 改为 strict ArtifactRef；Python/Rust invariant 拒绝 context、Tool Result 和 completed output 跨 Task。
- active canonical、CrewON distribution 和 provenance digest 字节一致；`./scripts/verify-agent-platform-provider-contract.sh` 与 Rust 237 项 protocol tests 通过。

## Breaking-change 审核

- app-server/Agent Platform 运行 API：均未新增或修改 RPC/HTTP endpoint；W0-03 只增加离线 contract 类型、fixture 和测试。
- AgentRuntime、Task Runtime、Provider worker、数据库、配置、CLI、rollout 恢复：无变化。
- canonical source 只在 Agent Platform；CrewON 文件有 generated provenance，不允许作为第二编辑源。
- Rust provider contract 类型与 invariant 保持独立模块，测试位于 sibling 文件。Python contract 模块保持独立，未扩张 AgentRuntime/Open API 高触达文件。
- schema bundle 大体积变化来自 generator；非机械逻辑按 W0-01/W0-02/W0-03 独立 review stage 拆分。
- Agent Platform 历史 Open API 文件完整 ruff 仍有 B008、UP041、UP045、B904、E501 等存量问题；本 Wave 只要求新增文件完整 ruff、旧授权文件 F/I，不做无关机械重写。

## 未验证

- 未启动真实 Provider Run 或 live smoke；W2-02A 已实现 lifecycle kernel，但 production API/worker/AgentRuntime adapter 属于 W2-02B。
- 按仓库规则，cuican-aide workspace 完整 <code>just test</code> 仍需用户明确允许；已完成受影响 protocol crate 的 237 项完整测试。
