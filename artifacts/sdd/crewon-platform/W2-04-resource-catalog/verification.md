# W2-04RC Verification

状态：E2 Green，experimental `resource/list`、`resource/read` 已通过 app-server v2 可达；Resource Binding、projection notification、UI 和执行链仍关闭。

## Discovery evidence

- `crewon-resource-federation::CatalogProvider` 已提供 bounded list 与 exact manifest read port；`ResourcePage` 最大 100 项，所有模型字段有界。
- `AgentPlatformProviderClient` 已实现该 port，并在同一 client 上持有 strict descriptor、pinned HTTP client 和 identity-scoped authorizer；Agent Platform 自身将 page limit 收紧到 50。
- Discovery 时 app-server `AgentPlatformProviderDescriptorFactory::read_descriptor` 连接 catalog client 后只投影 descriptor，无法让 Resource processor 复用该 session；E1 已用 catalog factory/session 消除该缺口。
- protocol Resource DTO 不接受 endpoint、owner、credential、grant、workspace root 或 executionLocation；read 的 protocol ResourceRef 不含 protocolVersion，因此必须由 connection record补全 domain ProviderRef。
- Discovery 时 provider connection processor 已有 I/O 前后 composite authority 双检，但 read 内联了 connection owner/grant 逻辑；E1 已抽出共享 begin/finish，避免形成两套授权实现。

## E1 implementation evidence

- Red Harness 最初只因 `provider_resource_catalog` / `provider_resource_processor` 尚不存在而失败，随后新增 sibling test module 并保持生产模块私有。
- production factory 在一次操作中建立一个 pinned、RS256-authorized `AgentPlatformProviderClient`，同一 client 同时持有 strict descriptor 并执行 list 或 read；没有先 `provider/read` 再二次连接。
- `ProviderConnectionProcessor` 抽出共享 begin/finish：I/O 前校验 connection owner、fresh mapping、active grant 和 credential revision，I/O 后重新解析并要求 authority 完全相同。
- list 默认 limit 20，接受 1..=100；cursor opaque；非已声明 kind fail-closed；Provider page 还受 Agent Platform 自身 50 项上限约束。
- read 从 connection 补齐 protocolVersion，要求 client providerId 与 connection exact 匹配，并要求 Provider 返回的 manifest ResourceRef 与请求 exact 相等。
- 成功响应只投影 ResourceRef、manifest metadata、cursor 和基于同一 live descriptor 的 provider ETag；错误和 Debug 不暴露 credential、grant、endpoint、owner 或 workspace。

## Verification commands

- `just test -p crewon-app-server provider_resource_catalog`：1/1 通过（最终安全 Harness）。
- `just test -p crewon-app-server provider_`：40/40 通过，1039 skipped。
- `just test -p crewon-app-server`：1079/1079 通过，1 slow、2 个既有时序用例 retry 后通过、1 skipped。
- `just fix -p crewon-app-server`：通过；仅剩 5 条与本切片无关的既有 warning。
- `just fmt`：通过。

## E2 wire evidence

- `resource/list` 与 `resource/read` 仅注册为 experimental v2、serialization None；stable schema 最终不包含方法，未扩大稳定 API。
- 独立 `ProviderResourceRequestProcessor` 穷举映射 bounded runtime error；`MessageProcessor` 只注入共享 runtime 并机械转发，不包含 Resource 业务逻辑。
- 真实 RS256 + SQLite + mapping/grant Harness 从 `provider/connect` 连续完成 Provider read、resource list 和 exact resource read；每次 Resource 操作仍只创建一个 descriptor/catalog session。
- TestAppServer 覆盖两个方法已注册、runtime disabled 时 fail-closed、experimental opt-in，以及 credential/endpoint/workspaceRoot 等未知 authority 字段在 dispatch 前被拒绝且不回显值。
- E2 新 request processor、sibling error Harness 和 TestAppServer 文件共 250 行；没有 bind/UI/执行逻辑混入。

## E2 verification commands

- `just test -p crewon-app-server provider_resource`：5/5 通过。
- 真实 request processor success Harness：1/1 通过。
- `just write-app-server-schema --experimental`：通过，并确认 experimental ClientRequest 包含两个 Resource 方法。
- `just write-app-server-schema`：通过，并确认最终 stable ClientRequest 排除两个 experimental 方法。
- `just test -p crewon-app-server-protocol`：242/242 通过。
- `just test -p crewon-app-server`：1082/1082 通过，1 slow、2 个既有时序用例 retry 后通过、1 skipped。
- `just fix -p crewon-app-server-protocol`、`just fix -p crewon-app-server`、`just fmt`：通过；app-server 仅剩 5 条既有 unrelated warning。
- 因修改了 protocol，完整 workspace `just test` 仍需按仓库规则获得用户明确授权后执行。

## Current gate

E1/E2 已证明单 catalog session、共享 begin/finish authority validation、exact projection 和受 experimental gate 保护的 wire。下一最小切片是 Durable Resource Binding / projection notification；W2-05、W2-06、W2-08 继续关闭，UI 与执行链不得直接消费尚未绑定的 ResourceRef。
