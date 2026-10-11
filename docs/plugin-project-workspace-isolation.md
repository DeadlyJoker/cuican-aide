# 插件项目工作空间隔离基础

验收日期：2026-10-11。

管理能力复用与后续接线顺序见[同一套项目管理的隔离方案](./plugin-project-management-isolation.md)。本协议保护工作空间及项目对话，不证明旧 CreativeProject metadata 的插件归属，也没有完成全部产物读写隔离。

插件项目继续使用宿主原有 Workspace、Thread、文件访问和执行体系。新增 namespace 只保存“哪个插件项目归属哪个宿主 workspaceId”，不创建第二套产品工作区，也不创建目录、切换宿主当前工作空间或授予执行权限。本轮已落地持久归属与原 Thread 写事务的隔离约束；完整项目工作空间产品接线尚未完成。

## 已实现的归属记录

`crewon.plugin-project-workspace-namespace.v1` 包含稳定 owner、宿主不透明 `workspaceId` 和 `createdAt`。owner 与已有 ProjectConversationBinding 的账号语义一致，严格包含：

| 字段                      | 隔离含义                               |
| ------------------------- | -------------------------------------- |
| `tenantId`、`spaceId`     | 原租户与空间                           |
| `principalId`、`actorId`  | 原真实账号与操作主体；本轮不改身份语义 |
| `profileId`               | 实际插件安装 profile                   |
| `pluginId`、`publisherId` | 插件及发布者                           |
| `projectId`               | 插件管理的项目                         |

包 `version`、`packageDigest`、selection revision、authority epoch 与临时 lease 不属于空间 identity。更换当前选中包不会改变已有 namespace；每次新写入仍必须校验当前安装权限与实际选中包。

记录不接受文件路径、cwd、凭据或额外 owner 字段。数据库按完整 owner 建立主键，`workspaceId` 全局唯一，记录不可更新或删除；完整相同记录可以重放，修改既有 owner 的 workspaceId 或 createdAt 会冲突。namespace 记录限制为 4096 字节，列表限制为每页 1–50 条，并提供 `nextProjectId` 游标。

实现位置：

- [Domain 类型与严格解析](../packages/domain/src/plugin-project-workspace-namespace.ts)
- [Application 只读端口及 Host 写入 recipe](../packages/application/src/plugin-project-workspace-store-port.ts)
- [独立 schema 与显式 migration](../packages/store/src/plugin-project-workspace-schema.ts)
- [SQLite 同库实现](../packages/store/src/sqlite-plugin-project-workspace-store.ts)
- [PostgreSQL 同池实现](../packages/store/src/postgres-plugin-project-workspace-store.ts)

## 实际入口与事务约束

原 SQLiteRunStore、PostgresThreadStore/PostgresDomainStore 提供以下内部 Host 接口；本轮未增加公共 HTTP 或 renderer 写协议：

| 接口                                                                 | 当前职责                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `pluginProjectWorkspaceNamespaces()`                                 | 返回只包含 `loadNamespace`、`listNamespaces` 的只读 facade       |
| `migratePluginProjectWorkspaceNamespaces()`                          | 显式创建独立 namespace schema；constructor 和普通 startup 不迁移 |
| `recordPluginProjectWorkspaceNamespaceFromPluginUi(context, recipe)` | 原 Host 的真实 live UI invocation 写入归属；不是客户端 grant     |

当前 namespace 写资格来自 PluginUiApplicationService 原 invocation 注册表中的真实对象与已捕获 transaction pin。复制、反序列化或构造 context 均不能取得资格；completed invocation 和关闭的 mount 不能继续写。owner 从原 pin 获取，recipe 只包含 `projectId`、`workspaceId`、`createdAt`。

SQLite 在进入写事务前完成原异步权限检查，进入同一个 `BEGIN IMMEDIATE` 后读取实际 installation selection/package，在 COMMIT 前再次校验实际 SQL selection 与同步 live 状态。PostgreSQL 实现在原池借用的一条 transaction connection 上校验、锁住 selection/package。namespace 创建与项目 binding 按同一账号/profile/project 的六字段 occupancy 锁串行化，再取得 workspace 锁；原 Thread/idempotency 锁仍先行，历史查询不反向取得 Thread 锁。PostgreSQL 在所有 SQL await 完成后，COMMIT 前再次 await 原 Host transaction authorization/epoch 检查，随后同步检查 live 状态与 parent open 并立即发送 COMMIT；该末端复核同时覆盖新写入和重放。权限、epoch 或最终 live 检查失败会回滚写入。SQLite 的 BEGIN 到 COMMIT 完全同步，没有异步间隙，沿用原 Conversation SQLite 事务模式；远端授权检查在 BEGIN 前完成，事务末端复核实际 SQL selection 与同步 mount/lease expiry。SQLite 不声称在同步 SQL 内再次调用异步远端授权。真实 PostgreSQL 等锁与回滚已验证，见下文。

namespace 不允许收养已经有 Thread 或历史 `thread.created` 事件使用的 workspaceId，避免将旧会话混入新插件项目。Host 后续接线必须从原宿主分配器取得 workspaceId，不能把 renderer 提交的 workspaceId 直接传入此内部 recipe；仅有 opaque ID 和 namespace 记录不等于目录存在或用户有文件访问权限。

旧项目与 Conversation 的 owner/profile/project 键没有独立插件字段，因此首次 namespace 会预留同一租户、space、principal、actor、profile、project 的项目身份，拒绝另一个已安装插件重新解释这个项目。持久 namespace 的完整八字段 identity 保持不变，既有相同记录先重放；首次写入拒绝该项目已有的普通或已撤销 binding，不改历史归属。独立 Conversation schema 完全缺席时仍兼容旧路径；部分 schema 或保留原 threads marker 列却丢失历史表时拒绝写入，不能当成全新项目。

原 Thread Store 的 create/fork 写事务已增加 [namespace fence](../packages/store/src/plugin-project-workspace-thread-fence.ts)：

- 普通 create 不可使用已归属插件项目的 workspaceId；仅传项目字段或包信息不会获得资格。
- 原 ProjectConversationStore 先验证其真实 commit authority、当前安装和 binding，再在同一事务内部生成私有 WeakMap qualification，创建 Thread、binding 与 receipt；公共 CommitThreadInput 没有新增可伪造 grant。
- binding 按实际项目身份和实际 workspaceId 分别检查 namespace，必须匹配完整 owner 和 workspaceId。空 workspace、普通 workspace、关联已有会话、其他已安装插件或重放都不能绕过项目归属。最终撤权使 Thread、binding、receipt 一起回滚。
- 普通 receipt replay 也校验返回的实际 Thread workspaceId，不能通过在请求中省略 workspaceId 取回项目创建回执。
- 普通 fork 不能继承已归属项目的工作空间，源 Thread 的实际 workspaceId 同样参与 fence。项目 fork 的复用 transaction 尚未实现，当前明确拒绝，避免生成无 binding 的 Thread。
- 未归属 workspaceId 保留原普通 create/fork 行为。没有 workspaceId 且没有需要检查的 fork 源时，不查询 namespace schema；replay 仍校验实际返回状态。

namespace read facade 本身不是用户授权接口。未来公开查询必须沿用原 Host 鉴权、实际 actor/profile/plugin identity 与 owner 范围，不可让 renderer 任意指定其他 owner。

## 兼容与当前未接线部分

旧 CreativeProject v0、ProjectConversationBinding、Thread 公共输入和宿主工作空间 registry JSON 不变。不迁移、搬移或重新绑定历史项目、会话与文件。缺少 namespace schema 时只读返回空结果，旧普通 workspace 路径保持兼容；新 namespace 写入要求先显式 migration。部分 schema、未知版本或缺失 immutable 约束会失败关闭，不静默修复为普通工作空间。

以下能力尚未接线，不能以持久层通过测试代替完整产品验收：

1. **原 Native Workspace allocator/registry 的产品接线。** [可信分配模块](./plugin-project-workspace-native-allocation.md)已实现真实目录、非激活式原 registry 追加、稳定 ID 与显式恢复；尚未接本 SQL namespace 事务。Native registered 不等于 SQL committed 或项目 ready，不切换全局活动 workspace。
2. **中央 Agent 与 Node provisioning。** namespace 模型为通用插件项目归属；当前真实写资格只绑定原 UI invocation。中央 Agent/Node 必须复用原宿主能力与真实权限通道，尚不能直接调用该内部 UI 写入口。
3. **旧 CreativeProject 查询的插件隔离。** 现有项目元数据查询没有因为新增 namespace 自动变成 plugin/project 范围；插件 CRUD、列表过滤和旧项目归属策略仍需后续绑定，不能默认将已有账号项目全归入某插件。
4. **项目文件面板与 workspace roster。** namespace 不提供文件根目录，也不自动改变原侧栏、活动工作空间或文件面板。后续需用原会话的 workspace binding 复用宿主文件能力，并按实际持久归属隔离展示。

## 本轮验证

后续验收使用任务自有 PG 18.6、随机 loopback 端口和独立临时数据库，未连接既有数据库、修改产品服务、启动 App、请求供应商或安装业务插件。限定以下八个文件：

```bash
env PATH=/Users/cheneywang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:/usr/bin:/bin \
  node --experimental-strip-types --test \
  packages/domain/src/plugin-project-workspace-namespace.test.ts \
  packages/store/src/plugin-project-workspace-store.test.ts \
  packages/store/src/plugin-project-workspace-postgres-lock.integration.test.ts \
  packages/store/src/project-conversation-store.test.ts \
  packages/store/src/project-conversation-schema.test.ts \
  packages/store/src/sqlite-run-store.test.ts \
  packages/store/src/postgres-thread-store.test.ts \
  packages/store/src/postgres-run-store.test.ts
```

为该命令设置任务自有数据库的 `CREWON_TEST_POSTGRES_URL`；结果为 **276/276 通过、20 suites、0 failed、0 skipped**，包括真实 PG RunStore/ThreadStore conformance。测试结束后已停止并删除该临时 PG，日常没有设置测试 URL 的运行仍会条件跳过；这不表示 CI 已配置数据库。

namespace SQLite/PG 测试通过原 PluginUiApplicationService lifecycle 和真实 SQL parent 执行，package verifier 与授权策略是明确命名的本地 fixture。覆盖显式 migration、稳定归属与分页/冷启动、普通 create/fork 拒绝与原 binding 事务成功、binding 不匹配与最终撤权回滚、旧历史不收编、第二个真实安装包无法冒领项目、空/普通/已存在会话绕行拒绝、伪造或完成 invocation、真实 closeMount 后 INSERT 回滚、包升级保持归属、坏 schema/历史 marker 拒绝，以及真实第二 installation writer 禁用 selection。Domain 另覆盖严格 shape、不透明 ID、路径及 accessor 拒绝。

使用同一固定 Node 24 PATH 分别运行并通过：

```bash
pnpm --filter @crewon/domain typecheck
pnpm --filter @crewon/application typecheck
pnpm --filter @crewon/store typecheck
pnpm crewon:boundary:check
git diff --check
```

PG 负例在原 Client 的 INSERT 成功后改变实际 Host policy/epoch，确认 invocation 失败且真实 SQL row 为 0。[并发集成](../packages/store/src/plugin-project-workspace-postgres-lock.integration.test.ts)还暂停 namespace 原事务，通过 `pg_blocking_pids` 确认另一个真实 pool 的 binding 正在等同一 occupancy 锁；撤权时 namespace 回滚而等待的普通 binding 可提交，正常提交时等待的空/普通 workspace binding 均拒绝且无 Thread、binding、receipt。SQLite/PG 都确认未迁移的 Conversation 原路径不会暗中建表或增加 marker 列。

上述 typecheck 均为 noemit；未构建共享 SDK/dist。这些是限定持久层与 Application 路径证据，不表示整个 monorepo、生产安装、Native 到 SQL 的产品接线或中央 Agent 已完成验收。
