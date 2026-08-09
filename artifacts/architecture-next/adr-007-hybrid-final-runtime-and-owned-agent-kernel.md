# ADR-007：TypeScript 业务内核与最小 Rust Device Runtime

状态：Accepted  
日期：2026-08-08  
取代：ADR-006

## 背景

ADR-006 选择了 Electron、Node Device Agent 和默认 OpenAI Agents SDK，目标是彻底消除 Rust 工具链。继续审计
当前实现后，这个选择并不是最优终态：CrewON 大量可区分能力位于 Agent loop、上下文、工具审批、恢复、Provider
传输和三平台本机执行语义中。前一类适合迁移到 TypeScript；后一类已有大量 Rust 平台安全原语，改写成 Node
会扩大供应链、资源控制和行为回归风险，同时 Electron 会增加桌面包体和内存。

OpenAI Agents SDK 官方文档说明 SDK 自带 Agent loop、session、tool execution、handoff、approval 和 tracing。这些
能力适合快速构建通用 Agent，但与 CrewON 需要保持兼容和可恢复的运行语义重叠。把 SDK 作为默认权威，会把迁移
目标从“保持产品行为”变成“接受框架行为”。

## 决策

1. Rust 产品业务后端归零；Agent、Thread、Workflow、Office、Provider、Memory、配置和 Store 迁移到 TypeScript。
2. PC 保留 Tauri + React；Tauri Rust 只承担桌面宿主能力。
3. 保留独立、最小的 Rust `crewon-device` Native Runtime，复用经过裁剪的 process、PTY、filesystem、patch、Git 和
   macOS/Linux/Windows sandbox primitives。
4. Native Runtime 不得依赖产品 domain、数据库、模型、MCP、Workflow、Provider 或 UI；它只接受版本化执行协议。
5. CrewON 自有 TypeScript Agent Kernel 是默认 Agent loop 权威。
6. Direct Responses-compatible Adapter 是默认模型传输；Provider 差异只能位于 Adapter。
7. 开源 `@openai/agents` 只作为可选 Adapter、功能试验入口和 conformance 对照，不得成为启动条件。
8. 不引入 Go；它既不能消除第二语言，也无法复用现有三平台 Rust 安全原语。
9. 迁移以行为 fixture、canonical event trace 和数据不变量为单位，不做语法级逐行翻译。

## 进程边界

```text
Tauri / React
  -> Control API / SSE

TypeScript Control API
  -> PostgreSQL or SQLite
  -> TypeScript Runtime Worker

TypeScript Runtime Worker
  -> CrewON Agent Kernel
       -> Direct Responses Adapter (default)
       -> OpenAI Agents Adapter (optional)
       -> Self-hosted Provider Adapter
  -> Device Gateway

Device Gateway
  -> versioned Device Protocol
  -> crewon-device Rust Native Runtime
       -> Process / PTY / Filesystem / Patch / Git / Sandbox
```

## 为什么不是 0 Rust

- “没有 Rust”不是用户价值；更快开发、低桌面开销、稳定执行和三平台安全才是目标。
- 当前 Tauri 自定义壳很小，迁移到 Electron 的收益低于包体、内存、升级和 native addon 成本。
- process tree cancellation、PTY、文件边界、补丁原子性和平台 sandbox 属于原生系统问题，不是普通业务 I/O。
- 独立 Native Runtime 通过 protocol、capability、lease 和 receipt 形成真正边界；语言统一不能替代这些约束。
- Rust 只保留在严格 allowlist 中，普通产品开发不需要进入 Cargo workspace。

## 为什么不是默认 Agents SDK

- SDK Runner 自带循环和状态语义；默认使用会与现有 CrewON 行为产生隐式差异。
- CrewON 的 durable Run、Step、Attempt、Approval、Action Digest、context hard cap 和 audit 必须由平台拥有。
- Direct Responses 路径能保留已有 streaming、`previous_response_id`、fallback、routing 和错误映射行为。
- SDK 仍有价值：可以快速验证新能力、作为对照实现，并在 conformance 通过后按 AgentVersion 显式选择。
- Adapter 边界保留未来退出或替换 SDK 的能力，不让 SDK 类型进入 domain、Store 或 wire contract。

## Rust 预算与依赖 Gate

最终 Rust workspace 不是现有 `codex-rs` 的缩小命名，而是新的显式 allowlist：

```text
crewon-desktop-shell
crewon-device
crewon-process
crewon-filesystem
crewon-sandbox
generated execution protocol types
```

约束：

- 任何新 Rust crate 需要架构 ADR；普通产品 feature 不得新增 Rust 代码。
- Native crate 不能导入 CrewON domain、Store、Provider、MCP、Workflow 或 Agent 类型。
- Rust 协议输入输出必须来自独立 JSON Schema/Protobuf 生成物，不手写复制产品 DTO。
- CI 输出 Rust crate allowlist、依赖图、二进制体积、许可证和 SBOM diff。
- 初始提取完成后设置源码和依赖预算；超预算必须说明平台必要性，不能以“已有代码”为理由自动保留。

## 2026-08-08 首个落地切片

- `packages/agent-kernel` 已拥有 bounded text segment loop；`packages/agent-responses` 已用平台 `fetch` 和自有 bounded SSE
  parser 实现 Direct Responses-compatible transport，生产依赖中没有 OpenAI Node SDK 或 `@openai/agents`。
- Runtime Worker 默认组合选择 Direct Responses；自托管 endpoint 不要求 API key，deterministic fake 保留为测试 Adapter。
- manual history 与 SDK-free provider checkpoint 是互斥输入，storage 默认关闭；启用后 checkpoint 与 terminal
  Message/Run 原子晋升，SQLite 重开后才允许映射为 `previous_response_id`。
- durable cancellation watcher 已能从第二 SQLite connection 的 cancel 主动中断 blocked Provider body；当前实现是 bounded
  polling，尚未外推为 PostgreSQL notification 或跨节点低延迟保证。
- 当前证据是本机真实 loopback compatible server、Kernel/Worker conformance、SQLite checkpoint restart、terminal rollback、
  主动 AbortSignal、idle timeout 和 provider retry classification；尚未外推为 live OpenAI、Tool 或完整 Step/Attempt 等价。

这些实现选择与官方 [Responses migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses) 的
手工历史/`previous_response_id` 两条续接路径保持一致。

## 后果

正向：

- 日常业务、Agent 和产品协议开发统一到 TypeScript。
- 保留 Tauri 的桌面体积优势和已有三平台原生能力。
- 自有 Kernel 可以逐项等价迁移现有 Agent 行为，不受高层框架默认语义约束。
- SDK、模型 Provider、Sandbox 和远程执行仍可替换。

代价：

- 最终仍有 TypeScript 与 Rust 两套构建工具，但 Rust 被隔离在低频平台团队边界。
- 需要维护 Device Protocol 和跨语言 conformance tests。
- 不能用一次大规模转译完成迁移；必须建设差分 trace、fixture 和 staged cutover。

## 验收 Gate

- Rust 中不存在 Agent、Thread、Workflow、Office、Provider、Memory、配置或产品 Store 逻辑。
- 普通产品需求和 Agent 行为变更不需要修改 Rust。
- Tauri/Native Runtime 只包含批准 allowlist，依赖方向 Gate 通过。
- CrewON Kernel + Direct Responses 是默认生产路径，并通过旧 Rust 行为差分测试。
- OpenAI Agents SDK 完全移除或关闭后，Standalone 和 Team 核心链路仍通过。
- Device Runtime 三平台覆盖 workspace escape、cancel、output cap、stale lease、replay 和 unknown outcome。
- 安装包、sidecar、Node runtime、Rust crates 和容器均进入签名、SBOM 与许可证扫描。
