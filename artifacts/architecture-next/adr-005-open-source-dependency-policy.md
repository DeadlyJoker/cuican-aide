# ADR-005：开源依赖与供应链政策

状态：Accepted  
日期：2026-08-08

## 背景

参考架构中存在未公开 Core、闭源 SDK、商业 Channel、内部 Feature Flag、APM 和 Marketplace。部分常见“开源 AI 产品”也采用 modified Apache、fair-code、branding restriction 或混合 enterprise 目录。

CrewON 的目标是核心控制面、Worker、Runner 和自托管主链路不依赖闭源组件或非开源许可。

## 决策

### 默认允许

```text
MIT
Apache-2.0
BSD-2-Clause
BSD-3-Clause
PostgreSQL
MPL-2.0
```

### 默认拒绝

```text
SSPL
BSL
FSL
Elastic License
Commons Clause
Sustainable Use / fair-code
modified Apache with product restrictions
custom branding restrictions
unknown or missing license
commercial-only code mixed into selected runtime path
```

GPL、AGPL、LGPL、EPL 和其他 copyleft/weak-copyleft 组件需要单独法律和分发评审，不能在普通依赖升级中自动进入产品发行物。

## Hosted Provider 边界

- 商业模型 API、SaaS Connector 或远程 Agent Provider 可以作为可选 Adapter。
- 至少一个完全自托管的 OpenAI-compatible 模型路径必须完成主链路验收。
- Hosted service 不得承担唯一 Auth、Queue、Event、Storage、Feature Flag 或 Observability 能力。
- 不把“源码可见”“可免费使用”或“可自托管”自动等同于 OSI 开源。

## 依赖准入记录

每个进入产品发行物的依赖记录：

```text
name + version
source repository
SPDX license
copyright/NOTICE obligations
direct or transitive
runtime/build/test only
distributed artifacts
owner
purpose
replacement or removal path
```

## 自动化 Gate

- lockfile 变更运行 license allow/deny check。
- 生成 CycloneDX 和 SPDX SBOM。
- 扫描实际桌面/容器/服务器发行物。
- 校验 source provenance 和 checksum。
- 对 unknown/multiple/custom license fail closed。
- 模型权重、embedding 模型、数据集和预构建二进制单独审计。

## 拒绝方案

### 只检查直接依赖 package.json/Cargo.toml

拒绝。限制许可和预构建二进制经常来自 transitive dependency 或打包阶段。

### 允许“当前未启用”的商业目录留在核心仓构建图

拒绝。是否执行和是否进入分发/衍生作品是不同问题，也会造成后续误启用风险。

### 先选技术，发布前再补许可证审计

拒绝。架构级组件一旦进入数据模型和协议，替换成本很高。

## 第一批候选

- Fastify。
- Kysely。
- PostgreSQL。
- pg-boss 或直接 PostgreSQL lease/outbox。
- Tauri 及其经过审计的 Rust 依赖。
- Node.js、TypeScript 业务运行时和最小 Rust Device Native Runtime。
- `@openai/agents`，但只允许位于可选 Adapter，Hosted 能力不得成为核心依赖。
- OpenTelemetry、Prometheus。
- OCI/containerd/runc/gVisor 或 Docker Executor。
- 官方 MCP TypeScript SDK。

候选不等于已批准；采用时仍需锁定具体版本、transitive dependency 和实际分发文件。

## 当前已落地审批

- Control API 固定 `fastify@5.11.0` 与 `uuid@14.0.1`。生产闭包只允许 MIT、BSD-3-Clause 和 ISC；
  `apps/control-api/scripts/check-production-licenses.mjs` 在 CI 中从当前 lockfile 重算并 fail closed。
- OpenAPI 类型生成固定 `openapi-typescript@7.13.0` 和 `prettier@3.5.3`，仅为开发依赖，不进入 Control API
  生产运行时；`packages/contracts/scripts/check-development-licenses.mjs` 对其开发依赖闭包执行许可 allowlist。
- 仓库 `minimumReleaseAge` 曾拒绝刚发布的 `fastify@5.11.3`；没有添加例外，选择通过成熟窗口的 `5.11.0`。
- Responses WebSocket Adapter 固定 MIT `ws@8.21.1`；`@types/ws@8.18.1` 仅用于开发。仓库七天
  `minimumReleaseAge` 拒绝了发布不足一天的 `ws@8.21.3`，没有添加例外或引入闭源 Agent SDK；Runtime Worker 的生产
  dependency license Gate 已从 lockfile 重算并通过。

这些批准只覆盖当前 lockfile 中的上述闭包。任何版本或 transitive dependency 变化都必须重新通过 Gate；完整发行物
仍需 SBOM 与打包内容审计。

## 验收 Gate

- PoC 主链路在无商业 SDK、无 hosted queue/storage/APM 下运行。
- 依赖扫描对一个 intentionally denied fixture 能 fail。
- SBOM 能映射到实际发行物。
- 所有可选商业 Provider 可以关闭且产品仍能启动并运行自托管模型主链路。
