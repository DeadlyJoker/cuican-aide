# Worker 的独立插件积分结算

原 Worker 可显式装配独立财务权威，后台分页读取已安装任务的原准入，再调用[原子结算决定层](./installed-plugin-credit-finalization.md)。没有配置时不创建财务 authority、不调用结算 Store、不迁移账务或恢复索引。原用户栏、Settings、侧栏、公共样式、插件 SDK 和 SSE outbox 不属于本次修改范围。

## 显式部署

设置 `CREWON_PLUGIN_CREDIT_SETTLEMENT_CONFIG_PATH` 指向绝对路径的私有 JSON 文件。文件必须是当前进程用户所有、权限 `0600` 的单链接普通文件，最多 64 KiB；symlink、读取中替换或变化、无效 UTF-8 均拒绝。配置没有默认身份、积分池、余额、价格或失败退款规则。

```json
{
  "schemaVersion": "crewon.plugin-credit-settlement-worker.v1",
  "scope": {
    "tenantId": "EXPLICIT_TENANT",
    "spaceId": "EXPLICIT_SPACE",
    "profileId": "EXPLICIT_PROFILE"
  },
  "authorityId": "EXPLICIT_FINANCIAL_AUTHORITY",
  "authorityRevision": "EXPLICIT_RULE_REVISION",
  "authorizationAuthority": {
    "url": "https://YOUR-FINANCIAL-SERVICE/authorize",
    "serviceTokenEnvironmentVariable": "CREWON_FINANCIAL_AUTHORIZATION_TOKEN"
  },
  "decisionAuthority": {
    "url": "https://YOUR-FINANCIAL-SERVICE/decide",
    "serviceTokenEnvironmentVariable": "CREWON_FINANCIAL_DECISION_TOKEN"
  },
  "timeoutMs": 5000,
  "maxAuthorizationAgeMs": 30000,
  "batchSize": 8,
  "intervalMs": 1000,
  "maxRoundMs": 10000,
  "migrate": false
}
```

这是协议示例，需要替换实际值，不能直接部署。财务 tenant 必须与原 Worker tenant 相同。两个地址只接受 HTTPS，不接受 URL 凭据、query、fragment 或 redirect；各自的 Bearer token 从明确命名的环境变量读取，不进入日志或配置序列化。执行、安装、PDP 和供应商凭据不能代替财务授权。`batchSize` 为 1–16；`timeoutMs`、`maxAuthorizationAgeMs`、`maxRoundMs` 为 1–30000 ms；`intervalMs` 为 1–3600000 ms。

`migrate: true` 才执行原最终决定迁移和独立恢复迁移。恢复迁移只增加 `plugin_credit_settlement_recovery_schema_version` 与四列恢复索引，不补建、伪造或修复原安装准入 schema；部分或不兼容 schema 拒绝启动。正常部署可先显式完成迁移，再使用 `migrate: false`。

Native 使用[独立环境投影](./native-plugin-credit-environment.md)，在原桌面启动边界只向当前 Worker 交付明确捕获的财务路径与 token。共享 runtime、模型目录和工作区子进程清理这些明确引用；保留名称冲突拒绝启动。原没有 provider 的 management 入口不因此新增结算 Worker。

## 财务 HTTP 协议

授权请求 `POST` 使用 `crewon.plugin-credit-settlement-authorization.v1`，携带完整 scope、authorityId、authorityRevision。allow 响应必须精确返回同一 scope 和权威修订，以及非空 `authorityEpoch` 和规范 UTC `expiresAt`；deny 不提供 epoch 或期限。接受的期限不得超过本次请求开始时间加 `maxAuthorizationAgeMs`。同时核验 UTC 与单调时钟，不因系统时钟后退延长许可。

每次独立授权刷新暂时撤下当前许可，并保留旧授权的到期约束；刷新跨过旧期限也不能用同 epoch 延长许可。deny、期限到达、epoch 改变、请求/响应错误或超时永久撤回当前 owner。恢复必须重新构建明确授权的 owner；轮询间隔和实际权威授予的有效期需要匹配，停机后不自动重新领取权限。

决定请求 `POST` 使用 `crewon.plugin-credit-settlement-decision-request.v1`，携带同一 scope、权威身份和修订、当前 epoch 与原 Store 生成的有界完整证据。响应为 `crewon.plugin-credit-settlement-decision.v1`，精确绑定 evidenceDigest、authorityId、authorityRevision、decisionId，outcome 仅为明确的 `hold`、`release` 或 `settle`。settle 的 actualCredits 是不超过原报价的非负十进制整数字符串。付款人、积分池和报价从原持久准入获得；UI、模型或恢复配置不能替换。

HTTP 同时只有一个物理请求槽。响应最多 16 KiB，严格校验 HTTP 200、JSON media type、UTF-8 与字段。超时仅撤权和 abort；原 fetch、body read/cancel 真正结束之前，promise 和槽保持占用。关闭同样等待原物理请求，不用逻辑超时证明退场。

## 扫描和生命周期

扫描仅使用原 `plugin_task_admissions` 的 tenant、space、profile 和 run_id 元数据，按 SQLite BINARY / PostgreSQL C 四列索引分页，读取 `limit + 1`，返回最多 16 项。严格核验真实表、marker、版本与索引；PG 还核验有效、ready/live、非部分、非表达式、升序 btree 和四项内建 text_ops。每项再从原 Store 读取完整付费和执行证据，元数据不能自行证明可以扣费。

扫描包含原 hold、未完成和已经结算的任务；不先用钱包、终态 JSON、join 或 NOT EXISTS 过滤后才 LIMIT。游标跨过已检查槽，末页后回到开头；单轮预算用尽时保留尚未处理的有界页。重复读取已经提交的不可变决定不再次请求金额或扣费。

Worker 的 poll 只安排一轮，立即返回；原轮真正结束前不安排第二次扫描。财务 HTTP 等待在事务之外。实际 DB 查询仍使用原父 Store 的连接池和锁；单连接 PG 池或同一账户/Run 的锁竞争可能使普通 Store 操作排队，不能把非阻塞调度表述为所有数据库配置下完全无争用。

Store factory 捕获独立 owner 的同步 `assertCurrent`，与父 Store 生命周期一起核验，在原查询和 COMMIT 前拒绝撤权。确认 COMMIT 后关闭仍返回真实成功。Worker 和 composition 的 stop 阶段同步撤权，等待 service、authority、扫描和 Store 原 promise 结束，再关闭资源和父存储；coordinator 自身只借用父 Store。

## 验证范围

实际 SQLite/独占 Unix socket PostgreSQL 18 用于分页、索引损坏、owner 撤回、资金/事件保持、Worker 原发布装配和重新打开后的原决定读取。普通 Worker 的流式/Tool continuation 专项同时挂起真实 coordinator 的具名 Store scan，核对新一轮请求上下文与关闭等待。财务 HTTP 单测使用明确的 fetch 夹具；个人身份、资金、规则与金额均为具名测试值。

同进程新 composition / 新连接不等于 OS 崩溃重启；fixture HTTPS/模型不等于生产财务服务或 ComfyUI。实际结果、退出码和首次失败以[实施进度](./incremental-extension-progress.md)和 `output/extensions/checks/credit-settlement-worker-proof-20261004.json` 为准。真实身份、资金入账、价格/失败规则，以及 Native 在线生成、同次完整 App S0、所有插件打包链路和实际企业 API 的 E5 仍需验收。
