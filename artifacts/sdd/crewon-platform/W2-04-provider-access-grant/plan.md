# W2-04PAG Implementation Plan

## Stage D: Contract Discovery（已完成）

1. 对照 Agent Platform Provider Run authorization、materialization 和 credential resolver，确认云模型 Secret 由 Provider 服务端解析。
2. 审计 CrewON `CredentialStore` 与 Provider connection processor，确认当前生产链没有 Credential provisioning，Secret-bearing store 不能作为授权 grant 的占位容器。
3. 撤回未注册的 client-selected Credential connect processor 和 selection DTO；保留 durable connection State 与 production descriptor factory。

## Stage A: Secret-free Grant Kernel

1. [x] 定义独立 strict metadata、create-or-resolve/current/active/revoke outcome；不依赖 `CredentialStore`。
2. [x] 使用独立 State migration 保存 bounded、hashed、Secret-free grant record；各 production module 低于 500 LoC。
3. [x] Red/Green Harness 覆盖 exact replay、并发单 winner、owner/source/scope/revision 隔离、expiry/revoke/tamper/capacity 和 Debug redaction。

## Stage B: Agent Platform Provisioning

1. [x] provisioner 只接受 verified principal owner、fresh exact mapping、issued session expiry 和 server-owned discovery scope policy。
2. [x] 把 bootstrap/exchange 成功链作为一次性 proof boundary；mapping 持久化、principal session 签发、grant provisioning 任一步失败都不向客户端返回 session/grant authority。
3. [x] 复合 authority Harness 覆盖无认证/logout 后请求、context switch、mapping revoke、source revision drift、grant expiry、State reopen 与重复 resolve；真实 transport revoke feed 继续由 authenticated-principal Harness 所有。

## Stage C: Provider Connection Rebuild

1. [x] 内部 connect command 只包含 `providerId`；服务端解析唯一 active grant。Wire `ProviderConnectParams` 延后到真实 RPC 注册切片，避免提前暴露空 API。
2. [x] 重建未注册 connect/read processor core，外部 descriptor I/O 前后双检 grant + mapping，immutable connection record 本身不授予权限。
3. [x] 独立实现 deterministic secret-free projection adapter；移除 Provider projection 中未注册的 CredentialRef 字段，不投影 owner/source binding/grant id/revision/scope/Secret，ETag 不包含 observedAt。
4. [x] 完成 startup composition、restart/config-removal/readiness Harness；Provider 启用时必须在 transport accept 前复用 principal identity reader 刷新全部 bounded durable mappings，依赖缺失、source/state/snapshot 失败均 fail-closed，配置关闭/移除不恢复旧 authority。
5. [x] 注册 `provider/connect/read` 与方法级 schema/TestAppServer Harness；接线切片才增加 runtime read 入口，没有预留未使用 API。

## Review Gate

- Stage A record/runtime 与 Stage B provisioner/composition 分成独立小提交；每个 production module 小于 500 LoC，每个 review slice 的非机械 diff 目标小于 500 行、总变更不超过 800 行。
- 不修改 Agent Platform 内部模型凭据表，不新增浏览器 Secret storage，不改旧 Agent Platform chat API。
- 任一阶段不能独立解锁 W2-05/W2-06/W2-08；只有方法级 RPC 与 production Harness Green 才更新上游 Gate。
