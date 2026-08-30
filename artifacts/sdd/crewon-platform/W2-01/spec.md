# W2-01 Specification: Agent Platform Provider Run 数据与授权事务

## 1. 目标

W2-01 在 Agent Platform 建立 Durable Provider Run 的最小数据与授权内核：

1. 持久化 Run、Attempt、Event、Delegation consumption、Authorization Decision 和 Outbox。
2. `start` 在单个数据库事务中完成授权重验、delegation jti 防重放、幂等判断、Run/Attempt、`runStarted` Event、Authorization Decision 和 Outbox 写入。
3. 提供统一的 existing-run ownership authorizer，供后续 read/events/cancel/approval/tool-result API 复用。
4. 不调用、不修改、不包装现有 `AgentRuntime`；executor、worker、API 和事件生命周期属于 W2-02。

本阶段不把 one-shot chat/SSE 伪装为 durable run，不注册生产路由。

## 2. 当前真实入口

- 当前云 Agent 执行入口是 `backend/app/api/v1/agent_open_api.py` 的同步 chat/chat-stream。
- `backend/app/services/agent_runtime.py` 是超过 2600 行的 Agent Loop，高触达且已有未提交流式改动；W2-01 不进入该文件。
- Agent Catalog/权限目前由 Agent、Space、permission-service 和 W0-02 Open API 授权共同提供。
- 数据库使用 SQLAlchemy `Base.metadata.create_all` 加兼容迁移，没有可作为主链的 Alembic revision 目录；新增表必须注册到 `app.models`，由现有 lifecycle 创建。
- W0-03 已冻结 canonical Provider Contract；W2-01 复用其中的 `ProviderAuthorization`、`StartCommand` 和 ResourceRef。W2-02 后续发现 Tool Intent 缺口并按 breaking-change 规则升至 v2，不改变 W2-01 的 start/auth 数据不变量。

## 3. 信任边界

W2-01 service 不直接接受 HTTP body 构造的“已验证身份”。它只接受两类服务端对象：

- `ProviderRunAuthorizationContext`：未来由 W2-02 的 service credential + signed user delegation dependency 构造；包含 service audience/subject、tenant/space、subject、purpose、scopes、CredentialRef、delegation issuer/audience/jti/issuedAt/expiry 和 delegation 绑定的 ResourceRef。
- `ProviderResourceAuthorization`：未来由 Catalog/permission resolver 构造；包含资源 provider/type/id/revision、tenant/space、当前已授权 subject、resource scopes 和 executable 状态。它表达一次权限解析结果，不把资源 owner 当成唯一可执行者，因此兼容共享 Agent/Workflow。

W2-01 仍会在数据库事务内逐项比较这两个对象与 StartCommand，不能因为上游称其“verified”而跳过 tenant/space/subject/resource/scope/credential/delegation 检查。

签名解析、service credential transport 和 HTTP dependency 属于 W2-02；未经这些 dependency 构造的 raw request 不得进入 service。

## 4. 数据模型

### 4.1 `provider_runs`

- opaque high-entropy `id`，不能作为授权凭据；
- service audience/subject、tenantId、spaceId、subject、purpose；
- Credential ID 和 owner subject，不保存 Secret；
- exact provider/resource type/id/revision；
- `queued` status、revision、lastSequence；
- idempotencyKey、caller requestDigest、server requestFingerprint；
- bounded canonical start input；
- integer Unix seconds timestamps。

唯一键固定为 `(serviceAudience, tenantId, spaceId, idempotencyKey)`。同 key 的其他 subject 不得到 conflict 细节，而按 ownership 不可见处理。

### 4.2 Attempt、Event 与 Outbox

- 创建 Run 时同时创建 attempt 1，状态 `queued`，executionRef 为空；W2-02 executor 成功接管后才能填 executionRef。
- Event 1 固定为 `runStarted`，`(providerRunId, sequence)` 和 `(providerRunId, cursor)` 唯一。
- Outbox topic 固定为 `providerRun.dispatch`，payload 只含 run/attempt ref，不复制 prompt、Credential、delegation 或 Context。
- Run input 只在 Run 表保留一份 bounded canonical JSON，避免 Run/Outbox 双写正文。

### 4.3 Delegation 与 Authorization Decision

- `(delegationAudience, jti)` 全局唯一，防止跨 tenant/space 复用相同授权令牌。
- issuer、issuedAt、expiresAt 必须有序，delegation 生命周期第一版最多一小时。
- Delegation 记录 operation、tenant/space/subject、Credential、Resource、scope digest、expiry、Run 和 decision ref。
- Authorization Decision 记录 allow 事实、operation、authorization digest、required scope 和时间；不保存 token、signature、Secret 或原始请求头。
- deny 不创建 Run，也不写可被外部枚举的资源记录。

## 5. Start 原子事务

事务内顺序：

1. 验证所有 ID/字符串/列表/Input JSON 的硬上限。
2. 验证固定 service audience、delegation audience 和 purpose。
3. 验证 required scope `providerRun:start`。
4. 验证 subject 等于 Credential owner。
5. 验证 authorization、resolved resource 和 StartCommand 的 tenant/space/provider/type/id/revision 一致，且当前 subject 已获授权、Resource scope 允许 start、资源可执行。
6. 按 scoped idempotency key 查询现有 Run：
   - 相同 owner + 相同 server fingerprint 返回同一 Run；
   - 相同 owner + 不同 fingerprint 返回 conflict；
   - 不同 owner 返回统一 not-found。
7. 验证 delegation 未过期、jti 未消费。
8. 写 Run、Attempt、Delegation、Authorization Decision 并 flush。
9. 写 `runStarted` Event 并 flush。
10. 写 Outbox 并 flush；事务提交。

任一 flush、constraint 或 commit 失败，全部回滚。

server fingerprint 使用 canonical JSON + SHA-256，覆盖 service/tenant/space/subject/purpose/Credential、Resource、caller requestDigest 和 bounded input；不依赖客户端自行声明的 digest 判断“相同请求”。

## 6. Existing-run 授权矩阵

统一 operation：

| Operation | Required scope |
| --- | --- |
| read | `providerRun:read` |
| events | `providerRun:events` |
| cancel | `providerRun:cancel` |
| approval | `providerRun:approval` |
| toolResult | `providerRun:toolResult` |

每次授权必须重新验证 service audience/subject、tenant/space、subject/Credential owner、exact ResourceRef、delegated scope、Resource scope、purpose、delegation issuer/time/jti 和 Run ownership，并在同一事务消费 jti、记录 allow decision。

Credential ID 可以轮换；existing-run ownership 绑定 Credential owner 而不是原 Credential ID，但每次 Decision/Delegation 都记录本次实际 CredentialRef。资源 disabled 后不得启动新 Run，但已有 Run 仍允许 read/events/cancel；是否允许 approval/toolResult 由当前 Resource scope 决定。

只要 tenant/space/subject/resource/credential/run ownership 不匹配，未知 Run 与越权 Run 使用同一个 `notFound` 语义。scope、audience、expiry 或 malformed authorization 使用不包含资源细节的受控 forbidden/invalid 错误。

## 7. Bounds

- prompt：最多 10,000 Unicode 字符，UTF-8 与 canonical input JSON 均有字节上限；
- contextRefs：最多 32 项，每项 bounded；
- scopes：最多 32 项且无重复；
- ID/subject/revision/idempotency/jti 均有明确 byte cap；
- Run input JSON 最多 64 KiB；
- Event/Outbox metadata 最多 8 KiB；
- 所有 timestamps 必须是非负 Unix seconds，delegation expiry 必须大于 now。

## 8. 安全与正确性不变量

1. Run ID 高熵但不代替 tenant/space/subject/resource ownership 查询。
2. Repository 不提供只按 Run ID 的外部授权读取入口。
3. Credential 只保存引用和 owner，不保存 key/token/secret。
4. jti 在数据库中唯一消费，不使用进程内 set。
5. 幂等相等性使用服务端 fingerprint，不只相信 requestDigest；数据库唯一约束必须覆盖并发 stale-read 窗口。
6. Run、Attempt、Event、Decision、Delegation 和 Outbox 必须原子提交。
7. Outbox 不复制 prompt、Context 或授权正文。
8. W2-01 不创建 worker、不调用 AgentRuntime、不产生真实外部副作用。

## 9. 非目标

- 不新增 Provider HTTP API、service credential parser 或 delegation signature codec。
- 不实现 worker claim/retry、AgentRuntime adapter、progress/terminal event、cancel、approval/tool-result mutation。
- 不修改 Agent、AgentVersion、Catalog、Open API 或 permission-service 数据模型。
- 不实现跨数据库事务或把 permission-service 数据复制成第二套 Authority。
- 不做生产 cutover，不删除 one-shot chat/SSE。

## 10. 验收

- 临时 SQLite Harness 覆盖授权成功、tenant/space/subject/resource/scope/Credential/delegation 拒绝。
- replay jti 被数据库约束与 service 语义拒绝。
- 相同 idempotency key + 相同 fingerprint 返回同一 Run；不同 fingerprint conflict。
- 在 Run/Event/Outbox 三个 flush 阶段注入失败，六类记录全部回滚。
- read/events/cancel/approval/toolResult 使用同一个 ownership authorizer，并覆盖 unknown/foreign Run 不泄露。
- schema/index/constraint 检查通过，模型注册进现有 DB lifecycle。
- 目标 pytest 和新增文件完整 ruff 通过。
