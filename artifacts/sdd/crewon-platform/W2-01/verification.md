# W2-01 Verification

状态：W2-01 数据与授权事务实现、Harness 和静态审计完成；尚未注册 Provider API、worker 或 AgentRuntime executor。

## Baseline

- `uv run --frozen pytest tests/test_agent_open_api_authorization.py tests/test_provider_contract.py -q`：13 passed。
- Agent Platform 当前没有 `app/modules/provider_run` 或 durable run 表/API。
- 当前 `AgentRuntime` 与 LLM streaming 文件存在用户未提交改动，W2-01 明确不修改。
- 当前数据库主链为 `app.shared.database.init_db -> import app.models -> Base.metadata.create_all`，没有主 Alembic revision 链。

## Required evidence

| Case | Expected | Evidence |
| --- | --- | --- |
| valid start | six record groups atomically committed | exact object and row-count assertions passed |
| tenant/space/subject mismatch | reject, zero rows | start authorization matrix passed |
| resource/provider/revision mismatch | reject, zero rows | exact ResourceRef matrix passed |
| delegated/Resource scope missing | reject, zero rows | both scope layers asserted |
| credential owner mismatch | reject, zero rows | start and existing-run cases passed |
| expired/future/overlong/replayed jti | reject; no second run | time bounds + precheck + DB unique race passed |
| exact idempotent retry | same run, no duplicate rows | normal retry + stale-read race passed |
| idempotency mismatch | conflict | prompt and CredentialRef changes asserted |
| Run/Event/Outbox flush failure | total rollback | three injected flush stages passed |
| existing-run operations | one ownership matrix | read/events/cancel/approval/toolResult table test passed |
| foreign vs unknown Run | identical notFound semantics | tenant/space/subject/resource/revision/service principal passed |
| Credential rotation | same owner may manage old Run | rotated CredentialRef authorization passed |
| disabled resource | start denied; existing cancel allowed | both cases passed |
| SQLite/PostgreSQL schema | constraints compile | SQLite inspection + PostgreSQL DDL compile passed |
| Secret/raw token | absent from schema/event/outbox | column/source scans + payload assertions passed |

## Commands

- `uv run --frozen pytest tests/provider_run -q`：47 passed。
- `uv run --frozen pytest tests/provider_run tests/test_agent_open_api_authorization.py tests/test_provider_contract.py -q`：60 passed。
- `uv run --frozen ruff check app/modules/provider_run tests/provider_run app/models/__init__.py`：passed。
- `uv run --frozen mypy app/modules/provider_run tests/provider_run`：passed，11 source files。
- `git diff --check`：passed。
- production module line count：authorization 334、models 247、repository 75、service 341，均低于 500 行。
- AgentRuntime/API/network call-site scan：passed，无引用。
- Secret field/source scan：passed。

## Non-cutover evidence

- W2-01 不注册路由、不启动 worker、不调用 AgentRuntime。
- 现有 Open API 和流式改动保持原样。
- 新表通过 `app.models` 注册进现有 `Base.metadata.create_all` lifecycle；W0 Open API 集成 Harness 启动真实 `init_db` 后仍通过。
- Outbox 只保存 run/attempt ref，Event 只保存 revision；prompt 只在 bounded Run input 中保存一份。
- 新模块没有 HTTP client、FastAPI router、进程内 Run Future 或真实外部副作用。

## Deferred to W2-02

- service credential transport 验证和 signed delegation 解码；只有该 dependency 可以构造 `ProviderRunAuthorizationContext`。
- Provider API、outbox worker、AgentRuntime 窄 executor、progress/terminal events、cancel/approval/tool-result mutation。
- 真实 PostgreSQL 集成环境 smoke；W2-01 已做 PostgreSQL DDL compile，但没有连接外部数据库。
