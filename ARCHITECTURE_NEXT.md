# CrewON Next Architecture（迁移期历史）

状态：Superseded  
日期：2026-08-08

本文件原来描述早期 TypeScript Control Plane + Rust Device Runner 的迁移提议和纵向 PoC。它的协议分层思想被
最终态吸收，但当时的模块边界、默认 SDK 和 PoC 验收不再作为实现依据。

最终目标架构：

- [`ARCHITECTURE_FINAL.md`](./ARCHITECTURE_FINAL.md)

仍可复用的领域、协议、Authority 和供应链决策已经整理到
[`artifacts/architecture-next/`](./artifacts/architecture-next/)；最终 Native Runtime 边界以 ADR-007 为准，旧
Runner PoC 只保留为迁移历史。
