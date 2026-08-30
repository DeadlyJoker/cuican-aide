# CrewON Final Architecture Decisions

状态：Accepted target decisions  
日期：2026-08-08

本目录保存 `ARCHITECTURE_FINAL.md` 的决策记录。旧 Rust Runner PoC 和 Node-only 方案仅保留为历史。

| 文件                                                     | 决策                                             |
| -------------------------------------------------------- | ------------------------------------------------ |
| `adr-001-typescript-control-plane-rust-runner.md`        | 已被后续方案取代的历史方案                       |
| `adr-002-run-step-event-domain.md`                       | Run/Step/Attempt/Event 领域模型，Office 作为投影 |
| `adr-003-rest-sse-runner-protocol.md`                    | REST、SSE 和 Device Protocol 分工                |
| `adr-004-authority-storage-and-migration.md`             | PostgreSQL/SQLite Authority 与旧数据迁移         |
| `adr-005-open-source-dependency-policy.md`               | 开源许可证与供应链政策                           |
| `adr-006-typescript-node-final-runtime.md`               | 已被 ADR-007 取代的 Node-only 历史方案           |
| `adr-007-hybrid-final-runtime-and-owned-agent-kernel.md` | TS 业务内核、Tauri、最小 Rust Native Runtime     |
| `poc-001-thread-runner-vertical-slice.md`                | 已取代的 Rust Runner PoC 历史                    |

Accepted 表示目标架构已经决策，不表示代码已经完成。实施过程中发现的反例必须回写 ADR，不能只以代码事实覆盖
文档决策。
