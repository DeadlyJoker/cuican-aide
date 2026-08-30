# ADR-001：TypeScript 控制面与 Rust Device Runner（已取代）

状态：Superseded by ADR-007  
日期：2026-08-08

本 ADR 保留最初缩减 Rust 的决策历史。最终态保留重新划界后的最小 Rust Native Runtime；以
`adr-007-hybrid-final-runtime-and-owned-agent-kernel.md` 和根目录 `ARCHITECTURE_FINAL.md` 为准。

## 背景

当前 `crewon-app-server` 和 `crewon-core` 同时承担产品控制面、Agent 编排、协议、持久化、Provider、工具和平台执行。Rust workspace 和依赖汇聚提高了日常开发成本，也让多数产品需求必须修改 Rust 和生成协议。

另一方面，进程、PTY、文件、Git、Patch、macOS/Linux/Windows 权限与沙箱是高权限、跨平台且容易产生内存和并发安全问题的能力，完全用 Node.js 重写不会直接产生产品价值。

## 决策

1. Control API、Agent Loop、Workflow、Office、Provider、Resource 和 Memory 编排使用 TypeScript。
2. Rust 只保留独立 Device Runner 和平台执行 primitives。
3. Runner Protocol 不包含 Thread、Office、Workflow、Memory、Model Provider 等产品 domain 类型。
4. Runner 不访问产品数据库，不持有长期 Provider credential，不决定 retry 或 terminal state。
5. Standalone 可以把 API 和 Worker 同进程运行，但 Runner 必须独立进程。

## 原因

- 现有 UI 和产品领域已经以 TypeScript 为主，跨端 generated client 可以减少 DTO 漂移。
- Agent 编排主要是网络 I/O、状态机和流式事件，不需要 Rust 的 CPU 性能优势。
- 高权限执行仍由 Rust 隔离，避免把安全边界降级成普通 Node child process helper。
- 单独 Runner 可以服务 Standalone PC、Team/Cloud Device Mesh 和未来远程 sandbox，而不复制业务控制面。

## 拒绝方案

### 继续扩展 Rust app-server/core

拒绝。即使再拆 crate，产品语义仍需要进入 Rust protocol、core 和 app-server，不能解决控制面汇聚。

### 全部改成 Electron Main Process

拒绝。Electron Main 不适合作为 Web/Mobile 共享后端，也会把当前 Rust 巨石换成桌面宿主巨石。

### 全部改成 Python

暂不采用。Python Agent 生态成熟，但桌面打包、类型契约和现有 React/TypeScript 团队路径成本更高。Python 可以作为 MCP/Tool/Provider 进程存在。

### 全部改成 Go

暂不采用。Go 可以实现 Runner，但重写现有跨平台 Rust 执行能力收益不足；业务控制面仍会产生跨语言类型边界。

## 后果

正向：

- 产品需求主要进入 TypeScript，开发和测试反馈更快。
- PC/Web/Mobile 共享 schema 和 generated client。
- Rust 编译范围收缩到低层执行能力。
- Runner 形成清晰的高权限安全边界。

代价：

- 迁移期存在旧 Rust 控制面和新 TypeScript 控制面两套进程。
- 需要设计稳定 Runner Protocol 和跨进程 cancel/backpressure。
- Node.js Worker 的内存、长连接和 CPU 密集任务必须有明确限制。

## 验收 Gate

- PoC 完成模型流、审批、Runner Tool、持久化和 SSE 重连。
- Runner build graph 不依赖 product domain。
- macOS/Linux/Windows contract tests 覆盖取消、超时、输出上限和 workspace escape。
- 新路径不调用闭源 Agent SDK。

## 删除条件

当所有消费者迁移后，`crewon-app-server` 和 `crewon-core` 从产品发行物删除；只保留 legacy importer 所需的最小只读解析代码。
