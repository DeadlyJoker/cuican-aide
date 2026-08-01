# W1-07 Verification

状态：实现、targeted Harness、scoped fix 与最终 fmt 完成。

## Evidence

| Requirement | Evidence |
| --- | --- |
| typed fragment | GovernedContextFragment 位于 core/context 并实现 ContextualUserFragment |
| provenance | Manifest 固定 source kind/source ID/server-derived actor ID |
| trust | Application 可 trusted；User/Tool/Provider/Knowledge/Memory/WorkspaceFile 声明 trusted 均拒绝 |
| sensitivity | Public/Internal/WorkspaceSensitive 可见；Secret 构建即拒绝 |
| bounded | 单 fragment 128..900 approximate tokens；Bundle 8 项/4K；Memory 6 项 |
| truncation | 超限 content deterministic middle truncation，Manifest 记录 original approximate tokens |
| freshness | future observed、invalid expiry、expired-at-build 均 fail-closed |
| incremental | 两个真实 /responses 请求比较：相同 fragment 只在历史中出现一次，没有重写或重复追加 |
| role safety | captured request 证明 trusted application 为 developer，Provider untrusted data 为 user |
| scope isolation | 同一 project 语义使用不同 Single/Experts/Office binding/thread；三个真实 request 只含各自 context |
| server authority | app-server adapter 只读取 RequestIdentity actor + path-free WorkspaceRef；scope mismatch 拒绝 |
| composition boundary | 未修改 v2 wire、旧 Office Prompt/Memory、业务 Processor 或中心路由 |

## Commands

- just test -p crewon-core governed_context: 7 passed, 2705 filtered/skipped。
- just test -p crewon-app-server context_adapter: 2 passed, 1013 filtered/skipped。
- just fix -p crewon-core: passed；消除了新增代码中的可避免 panic 点，最终无新增告警。
- just fix -p crewon-app-server: passed；仍有 5 个位于旧 Office/Agent Platform processor 的既有告警，本任务未扩大范围处理。
- just fmt: passed。

## Review

- 新增生产模块分别为 493、86、116 LoC，未扩大已有大 orchestration module。
- 未新增依赖、数据库、配置、API 或 rollout schema。
- 新增项不会跨 1K token P0 阈值；同时满足单项小于 10K 的全局规则。
- Tool/Provider/Memory/File 数据不能选择 developer role；Prompt 内容不能改变该结构性 role。
- Context Bundle 只保存 opaque binding/scope ID，不保存 canonical path 或 Secret。
- 完整 just test -p crewon-core 未运行：按 AGENTS.md，Core 全量测试需要用户明确批准；targeted unit + real outbound integration 已完成。
