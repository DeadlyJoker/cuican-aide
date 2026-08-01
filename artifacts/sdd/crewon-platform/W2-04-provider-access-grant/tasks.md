# W2-04PAG Tasks

- [x] D1 对照 Agent Platform，确认 delegation credential 是授权绑定，真实云模型 Secret 由 Provider 服务端解析。
- [x] D2 确认 CrewON production 没有 Credential provisioning，client-selected credential 首连不可达。
- [x] D3 撤回未注册 connect/read processor 与 `ProviderCredentialSelection` 输入 DTO。
- [x] A1 定义 Secret-free grant metadata、lookup、resolve/revoke outcome 和错误闭集。
- [x] A2 增加 `0044_provider_access_grants.sql`、State adapter、canonical hash/redaction 与 bounded JSON guard。
- [x] A3 完成 replay/concurrency/owner/source/scope/revision/expiry/revoke/tamper/capacity Harness。
- [x] B1 实现 verified principal + fresh mapping + issued session expiry 的 Agent Platform server-owned exact-scope grant provisioner。
- [x] B2 将 bootstrap/exchange 作为一次性 proof boundary；grant 失败时不向客户端返回已签发的 principal session。
- [x] B3 增加 Grant + fresh mapping 复合 authority resolver，覆盖无认证/logout 后请求、context-switch/mapping-revoke/source-drift/expiry/restart/replay Harness。
- [x] C1 定义只含 `providerId` 的内部 connect command；公开 Params 随真实 RPC 一起生成。
- [x] C2a 重建未注册 grant-aware connect/read processor core 与 descriptor I/O 前后 authority revalidation。
- [x] C2b 实现 secret-free ProviderConnection projection adapter 与 deterministic projection hash；预公开 DTO 移除 CredentialRef。
- [x] C3a 完成 startup/restart/config-removal/readiness composition，并在任何 transport accept 前建立 fresh mapping readiness token。
- [x] C3b 注册 provider/connect/read RPC，生成方法级 schema，并完成 TestAppServer Harness。
