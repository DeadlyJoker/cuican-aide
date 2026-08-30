# W2-01 Implementation Plan

## 1. Harness-first 顺序

1. 固定真实数据库 lifecycle、canonical contract 与 AgentRuntime/Catalog 边界。
2. 先写临时数据库测试，证明旧代码不存在 Provider Run 模块。
3. 实现独立 models、bounded authorization types、repository 和 transaction service。
4. 只把 models 注册到 `app.models`；不注册 API/worker，不修改 AgentRuntime。
5. 运行目标 pytest、ruff、schema/secret/call-site scan，更新 verification。

## 2. 文件边界

Agent Platform：

- `backend/app/modules/provider_run/models.py`：六类表与数据库约束。
- `backend/app/modules/provider_run/authorization.py`：server-owned auth/resource context、operation matrix、bounds 和错误分类。
- `backend/app/modules/provider_run/repository.py`：所有 scoped queries 和 persistence helpers。
- `backend/app/modules/provider_run/service.py`：start transaction 与 existing-run authorization transaction。
- `backend/tests/provider_run/`：临时数据库、rollback、idempotency、authorization 和 schema Harness。
- `backend/app/models/__init__.py`：仅模型注册。

CrewON 中央 SDD 只记录跨仓库契约和验证结果。

## 3. Review slices

1. W2-01A：models + schema/constraint Harness。
2. W2-01B：authorization context/matrix + deny Harness。
3. W2-01C：start transaction、idempotency、jti、rollback Harness。
4. W2-01D：existing-run shared authorizer + final verification。

单个生产模块保持低于 500 行；不向 `agent_runtime.py`、`agent_open_api.py` 或 Catalog 高触达文件增加逻辑。

## 4. 风险与回滚

- 新表通过现有 create-all lifecycle 增量创建，不修改旧表。
- 没有 API/worker consumer 时不改变现有产品行为。
- 删除模块和新表即可回滚代码；生产有数据后表删除必须独立迁移，不在本任务自动执行。
- 如果 canonical contract 无法表达未来签名 claims，W2-02 在 auth header/dependency 层补充，不修改 W2-01 的 DB Authority 或把 raw request 当 verified context。
