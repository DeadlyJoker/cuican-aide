# W2-02 Plan

## Stage A: Lifecycle Kernel

1. 冻结 executor port、状态机、event/mutation bounds 和 unknown-outcome 语义。
2. 扩展 schema：Attempt 生命周期时间、Event source identity、Outbox claim lease、Suspension、Mutation Receipt。
3. 先写 fake executor Harness，覆盖 capability、claim、duplicate、gap、terminal、cancel、suspend/resume 和 restart recovery。
4. 实现 transaction-internal authorization helper，保证 read/mutation 与授权事实同事务。
5. 实现 lifecycle repository/service、event reader、outbox processor；不接生产 main。
6. 运行目标测试、W0/W2 regressions、ruff、mypy、schema/secret/static scans。

## Stage B: Production Composition

1. 实现 RS256 service credential + signed delegation verifier；raw HTTP 不得直接构造 authority object。
2. 实现 Permission Space authority + Catalog resolver，并明确 exact published revision。
3. 实现 ProviderExecutionMaterialization；mutable/unversioned provider dependency fail-closed。
4. 修订 Provider Contract v3，绑定 signed taskId 并将 contextRefs 改为 strict ArtifactRef。
5. 实现 bounded Provider Artifact data-plane kernel；先支持 text context/report，其他媒体 fail-closed。
6. 先实现未注册的 strict Provider HTTP sub-app 与 atomic application port；完成 payload/header/error/Artifact raw-body Harness 后才允许 mount。
7. 实现独立 worker supervisor；完成 stale recovery、重复启动和 bounded shutdown Harness 后才允许接 lifespan。
8. 实现 Agent 窄 adapter：只调用既有稳定入口，不复制 loop；必须从 immutable materialization 和 exact credential route 执行，并在 completed 前提交 output Artifact。Workflow 保持 capabilityUnsupported，直到拥有同等级 materialization/runner。
9. 生产 composition 必须使用显式 trust keyset、显式 Permission Service secret、显式 MinIO 配置；任一缺失 fail-fast，不使用开发默认值或磁盘 fallback。
10. existing Run 授权必须从 persisted materialization 解析资源身份并重验当前 space access，不依赖可硬删除 Catalog；worker 的 execution/cancellation 双循环必须覆盖同 worker affinity 和取消后继续 dispatch。
11. 以默认关闭 feature gate 条件式 mount start/read/events/cancel 和 Artifact import/download API，并注册 worker；approval/tool-result 只有 adapter capability 满足时开放。
12. 使用独立凭据做 live smoke、取消/崩溃故障演练，清理数据并记录未支持能力。

## Review 拆分

- PR A1：schema + state/event/mutation Harness。
- PR A2：lifecycle service + fake executor/outbox processor。
- PR B1：auth dependencies + internal API。
- PR B2：real adapter + worker composition + live smoke。

## Stage C: Provider discovery amendment

1. 先增加 discovery token/header Harness，证明 Run/discovery token 不能互换。
2. 冻结 descriptor、list/read strict HTTP DTO、bounds、cursor 和 manifest digest。
3. 实现 bounded SQL candidate catalog + Permission access filtering；不调用旧公开 API。
4. 接入同一 Provider v3 sub-app 和 production composition；缺 discovery 组件时禁止 partial mount。
5. 运行 auth/catalog/HTTP/application 回归并更新 W2-03 解锁结论。

Review 拆分：C1 auth/DTO，C2 catalog/application，C3 HTTP/composition；每阶段复杂逻辑低于 500 行。

## Stage D: CrewON issuer and ownership gate

1. P2a 先在 `crewon-provider-agent-platform` 写 Red Harness，固定 service/delegation/discovery JOSE header、claims、scope、lifetime、JTI、exact Resource/Credential revision 与敏感值 redaction。
2. P2a 实现未注册的 RS256 `ProviderAuthorizer`；构造时校验 signing key、kid、canonical `user:<positive integer>`、tenant 和 space，错误统一且不暴露 key/claim。
3. 运行 Rust adapter 定向测试与 Agent Platform verifier 交叉兼容 Harness；在没有 P2b 之前不得把发行器注入 app-server 或 CloudWorker production composition。
4. P2b-1 建立 authenticated principal 到 Agent Platform tenant/space/user subject 的 durable server-owned mapping kernel、唯一性和撤销/轮换边界；P2b-2a 增加 exact principal/CredentialOwner/active mapping internal resolver。两者已完成且未接线。P2b-2b 再接真实 identity-session snapshot/mutation/revoke authority 与 freshness Gate。
5. 只有 P2b、真实 Provider smoke、supervised event pump 和生产 recovery 全部通过，才打开 CloudWorker/Provider production gate。

每个 PR 复杂逻辑控制在 500 行级别，生产模块保持低于 500 LoC；不把 lifecycle、worker、HTTP 和 AgentRuntime adapter 堆进同一文件。
