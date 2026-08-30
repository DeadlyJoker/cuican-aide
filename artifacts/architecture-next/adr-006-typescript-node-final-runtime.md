# ADR-006：TypeScript/Node-only 最终运行时

状态：Superseded by ADR-007  
日期：2026-08-08  
取代：ADR-001  
被取代：ADR-007

> 本 ADR 只保留决策历史。Electron、Node Device Agent、0 Rust 和默认 Agents SDK 不再是最终方案。

## 背景

ADR-001 的目标是把 Rust 收缩为 Device Runner，但仍保留 Tauri、Rust build graph 和第二种产品运行语言。
进一步评估表明，真正需要保留的是独立高权限进程和稳定执行协议，而不是 Rust 本身。

OpenAI Agents SDK 已提供 TypeScript Agent Runtime、Unix-local 和 Docker Sandbox Adapter，但 SDK Runner、
Sandbox compute、CrewON Device Agent 是三个不同边界。直接把 SDK 当产品权威会造成 Provider、状态、审批和
设备协议锁定；完全忽略 SDK 又会重复实现大量通用 Agent Loop。

## 决策

1. 最终产品运行时只使用 TypeScript/Node.js；不保留 Rust 或 Go 自研服务。
2. PC 从 Tauri 迁移到 Electron + React。
3. 本机高权限执行由独立 `crewon-device` Node 进程负责，不进入 Electron Main 或 Runtime Worker。
4. `crewon-device` 使用版本化 Device Protocol，承担 process、PTY、filesystem、patch、Git 和 sandbox adapter。
5. `@openai/agents` 是默认 `AgentRuntimePort` Adapter，不是持久化、领域或执行协议权威。
6. OpenAI Agents SDK 的 Unix-local/Docker Sandbox 只作为 `ExecutionProviderPort` 的可选实现。
7. 必须提供 Direct Responses Adapter、self-hosted Provider Adapter 和 deterministic fake。
8. Hosted Tool、Hosted Sandbox、OpenAI session 和 OpenAI tracing 均可关闭。
9. 关闭 OpenAI credential 和所有商业服务后，Standalone 主链路仍可运行。

## 进程边界

```text
Electron Renderer
  -> Control API / SSE

Control API
  -> PostgreSQL or SQLite
  -> Runtime Worker

Runtime Worker
  -> AgentRuntimePort
       -> OpenAI Agents Adapter
       -> Direct Responses Adapter
  -> Device Gateway

Device Gateway
  -> outbound WSS
  -> crewon-device Node process
       -> Host / PTY / Filesystem / Git / Docker
```

## 为什么不保留 Go Runner

- 独立进程、最小权限和 protocol boundary 提供主要安全隔离；语言本身不是授权边界。
- Node 已经是 Electron、Agent Runtime 和产品 Worker 的固定运行时，减少工具链、schema 和打包分裂。
- `child_process`、`node-pty`、filesystem 和 Docker API 足以覆盖目标执行原语。
- 将 Device Agent 限制为无产品领域、无模型、无数据库的窄服务，可以控制 TypeScript 的风险面。
- 如果未来某个平台原语必须使用原生代码，只允许放在开源、审计后的 native addon，不恢复 Rust 业务后端。

## 为什么不直接让 OpenAI Agents SDK 取代 Device Agent

- SDK Runner 是 Agent harness，不是 Device identity、mTLS、lease、receipt 和 workspace authorization。
- Sandbox Agents 当前属于 beta，不能成为持久化和设备协议 source of truth。
- Unix-local 适合开发，但不能自动满足 Windows、后台设备服务、远程 PC 和用户工作区治理。
- SDK Sandbox 可作为执行 Adapter；CrewON 仍拥有 Action Digest、Approval、Device Protocol 和审计。

## 后果

正向：

- 产品运行语言、类型、测试和开发工具链统一。
- Rust workspace、Cargo/Tauri 构建和 Go sidecar 均退出最终发行物。
- Agent SDK 提供开发速度，同时保留明确退出路径。
- Device Agent 仍是独立安全边界，不把权限放回 UI。

代价：

- Electron 包体和 Node 内存高于 Tauri。
- `node-pty` 等 native addon 仍需要三平台供应链和签名审计。
- TypeScript Device Agent 必须严格限制输入、输出、路径、进程和资源。
- SDK Adapter 与 Direct Adapter 都要维护 conformance suite。

## 验收 Gate

- 最终发行物不存在自研 Rust/Go runtime。
- Renderer、Electron Main、API、Worker 和 Device Agent 的依赖方向通过 CI。
- Device Agent 三平台 contract tests 覆盖 workspace escape、cancel、output cap、stale lease 和 replay。
- OpenAI Agents Adapter 与 Direct Responses Adapter 通过相同 canonical event suite。
- 无 OpenAI credential、无 Hosted Tool 时 self-hosted Standalone 完整通过。
- Electron installer、Node runtime 和 native addon 进入 SBOM、签名和许可证扫描。
