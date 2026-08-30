# W2-05 Implementation Plan

## P0: Discovery amendment

1. [x] 盘点 `pimDynamicTools.ts`、Core dynamic tool request、`McpConnectionManager`、W2-04 binding、W1-08 Policy 和 W1-09 Audit。
2. [x] 证明安全 Provider v3 只支持 Agent，旧 Tool/Knowledge API 不可 fallback。
3. [x] 证明 W2-04 当前拒绝 local materialization，binding record 没有 MCP locator。
4. [x] 冻结 Provider v3 与 Local materialization 两个前置 Gate。

## P1: Fail-closed route kernel

1. [x] Red：表驱动 Harness 覆盖唯一执行矩阵、unsupported kind/mode/location 和 namespace 冲突。
2. [x] 实现 server-owned registration、reserved namespace 和 exact binding snapshot。
3. [x] 实现 invocation bounds、binding drift 检查与 no-fallback target selection；owner/workspace revalidation 留在 P2 execution port。

## P2: Policy, journal and execution Harness

1. [x] P2a Red：read-only immediate authorization、mutation approval required、exact approval success、arguments change digest mismatch。
2. [x] P2a 实现 server-owned side-effect classification、owner/workspace/binding revalidation、live Credential resolve 与 durable journal claim port。
3. [x] P2a 覆盖 duplicate same/different digest、revoke、binding drift 和 raw-argument redaction。
4. [x] P2b 实现 server-owned Credential snapshot、consume-only dispatch、journal completion/Audit contract、timeout、unknown outcome、bounded output 和严格 no fallback；仅使用 Fake executors/journal，不宣称 production durable。

## P3: Production prerequisites

1. [x] CrewON 侧 Provider v3 Tool/Knowledge strict discovery/manifest、authorization、execute contract + Rust HTTP Harness Green。
2. [x] Agent Platform 生产服务实现并声明相同 Tool/Knowledge v3 contract、scope、幂等、审计与 Provider Artifact read/download；独立 feature gate 默认关闭。
3. [x] 重新核对 Provider capability 与产品路径：当前没有本地包下载契约，Local materialization 从 v1 Gate 移出并由 Router/State fail-closed；未来真实需求使用独立 SDD。
4. [x] State-backed execution journal、`0046` migration、restart recovery 与 atomic `ExternalAction` Audit adapter Green。

## P4: Adapter integration gate

1. [x] 删除未受真实 materializer 支撑的 Local adapter/target port；既有配置型本地 MCP 保持静态路径，不进入 Provider Dynamic Router。
2. [x] Provider executor kernel 只复用 strict Provider v3/pinned transport/short-lived delegation，生产 Credential resolver 在 claim 前重验完整主体/mapping/grant/connection。
3. [x] Provider Artifact importer 与 Agent Platform server endpoint Green；Provider Artifact 先精确下载、校验 digest/metadata，再进入本地 durable Artifact Store。
4. [x] Provider-only Router/State Harness 证明 LocalNode claim/registration fail-closed；Provider 侧 contract/server/client/executor/importer tests 已 Green。
5. [x] 更新 W2-08 原子接线、旧浏览器 PIM executor 删除与通用 client dynamic tool 保留清单；不在本任务修改中心文件。
