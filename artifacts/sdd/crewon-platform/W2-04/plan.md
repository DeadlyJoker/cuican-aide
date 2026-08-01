# W2-04 Implementation Plan

## Stage D: Discovery（已完成）

1. 审计 W1-01 RequestIdentity、W1-02 WorkspaceRegistry、W1-03 Credential owner 和旧 Agent Platform processor。
2. 证明 reconnect 后 actor/session 变化，旧 Workspace/Credential authority 不能安全复用。
3. 冻结 W2-04 实现，禁止以跨 session 放宽授权或客户端重传 Secret 绕过。

## Stage P: Authenticated Principal prerequisite

1. [x] 定义 transport-auth verified principal 与 connection session 的双层身份。
2. [x] 完成 WebSocket claims plumbing、expiry disconnect 和 reconnect/mix-up Harness。
3. [x] 完成 bounded revoke contract、WebSocket selective disconnect 与 RemoteControl no-principal protocol Gate。
4. [x] 接入真实 issuer/logout revoke source adapter 与产品端到端 Harness。
5. [x] 迁移 Credential owner/Provider identity 并实现真实 RS256 issuer kernel。
6. [x] 建立 path-free durable workspace root State mapping。
7. [x] authenticated-only app-server workspace adapter：重连/process restart 复用、scope binding/catalog removal fail-closed。

## Stage A-D: Provider API（前置通过后执行）

1. [x] durable Provider connection identity State kernel；禁止内存-only 假恢复。
2. [x] projection/resource protocol DTO 与直接 schema/TS Harness；client-selected Credential selection Params 经 review 撤回。
3. [x] server-owned durable connection State kernel 与 live Provider descriptor factory port。
4. [x] 默认关闭的 production Agent Platform descriptor factory/config kernel；复用 W2-03 endpoint guard、strict descriptor 与共享 RS256 key。
5. [x] Provider Access Grant prerequisite：Secret-free durable grant State、verified-principal fixed-scope provisioning 与 Grant + fresh mapping composite lifecycle Harness 已完成。不复用 Secret-bearing CredentialStore；scope 仅由服务端生成。
6. [x] 用 server-resolved grant 重建保持未注册的 connect/read processor core；内部 connect command 只含 providerId，descriptor I/O 前后双检 authority。
7. [x] secret-free projection adapter与 app-server startup/restart/config-removal/readiness composition；启用时在 transport accept 前刷新 durable mappings，关闭/移除配置不恢复 authority。
8. [x] provider/connect/read v2 RPC、方法级 schema 与 TestAppServer。
9. [x] resource list/read/bind/unbind processor、durable Resource Binding 与 current-connection-only projection notification。

## Gate

Stage P、Provider connection/Access Grant、projection/resource DTO、startup readiness、live Catalog、durable Resource Binding，以及 experimental provider/connect/read/resource list/read/bind/unbind RPC 已完成。原 A2a client-selected Credential processor 经 production review 判定首连不可达并已撤回。W2-05 与 W2-06 可以进入各自独立 SDD/Red Harness；W2-08 仍等待 W2-05、W2-06、W2-07，完整 workspace test 仍需用户明确授权。
