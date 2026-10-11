# 插件项目工作空间隔离基础

验收日期：2026-10-11。

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

SQLite 在进入写事务前完成原异步权限检查，进入同一个 `BEGIN IMMEDIATE` 后读取实际 installation selection/package，在 COMMIT 前再次校验实际 SQL selection 与同步 live 状态。PostgreSQL 实现在原池借用的一条 transaction connection 上校验、锁住 selection/package，并用 workspace advisory lock 串行化 namespace 归属与 Thread 创建；保留原 Thread/idempotency 锁先行顺序。PostgreSQL 在所有 SQL await 完成后，COMMIT 前再次 await 原 Host transaction authorization/epoch 检查，随后同步检查 live 状态与 parent open 并立即发送 COMMIT；该末端复核同时覆盖新写入和重放。权限、epoch 或最终 live 检查失败会回滚写入。SQLite 的 BEGIN 到 COMMIT 完全同步，没有异步间隙，沿用原 Conversation SQLite 事务模式；远端授权检查在 BEGIN 前完成，事务末端复核实际 SQL selection 与同步 mount/lease expiry。SQLite 不声称在同步 SQL 内再次调用异步远端授权。本地 PostgreSQL 行为未实际验收，见下文。

namespace 不允许收养已经有 Thread 或历史 `thread.created` 事件使用的 workspaceId，避免将旧会话混入新插件项目。Host 后续接线必须从原宿主分配器取得 workspaceId，不能把 renderer 提交的 workspaceId 直接传入此内部 recipe；仅有 opaque ID 和 namespace 记录不等于目录存在或用户有文件访问权限。

原 Thread Store 的 create/fork 写事务已增加 [namespace fence](../packages/store/src/plugin-project-workspace-thread-fence.ts)：

- 普通 create 不可使用已归属插件项目的 workspaceId；仅传项目字段或包信息不会获得资格。
- 原 ProjectConversationStore 先验证其真实 commit authority、当前安装和 binding，再在同一事务内部生成私有 WeakMap qualification，创建 Thread、binding 与 receipt；公共 CommitThreadInput 没有新增可伪造 grant。
- binding 必须匹配 namespace 的完整 owner 和 workspaceId。最终撤权使 Thread、binding、receipt 一起回滚。
- 普通 receipt replay 也校验返回的实际 Thread workspaceId，不能通过在请求中省略 workspaceId 取回项目创建回执。
- 普通 fork 不能继承已归属项目的工作空间，源 Thread 的实际 workspaceId 同样参与 fence。项目 fork 的复用 transaction 尚未实现，当前明确拒绝，避免生成无 binding 的 Thread。
- 未归属 workspaceId 保留原普通 create/fork 行为。没有 workspaceId 且没有需要检查的 fork 源时，不查询 namespace schema；replay 仍校验实际返回状态。

namespace read facade 本身不是用户授权接口。未来公开查询必须沿用原 Host 鉴权、实际 actor/profile/plugin identity 与 owner 范围，不可让 renderer 任意指定其他 owner。

## 兼容与当前未接线部分

旧 CreativeProject v0、ProjectConversationBinding、Thread 公共输入和宿主工作空间 registry JSON 不变。不迁移、搬移或重新绑定历史项目、会话与文件。缺少 namespace schema 时只读返回空结果，旧普通 workspace 路径保持兼容；新 namespace 写入要求先显式 migration。部分 schema、未知版本或缺失 immutable 约束会失败关闭，不静默修复为普通工作空间。

以下能力尚未接线，不能以持久层通过测试代替完整产品验收：

1. **原 Native Workspace allocator/registry 的可信分配。** 尚无本轮新增的真实目录分配、非激活式 registry 写口、重命名或清理接线；不会通过 namespace 写入切换全局活动 workspace。
2. **中央 Agent 与 Node provisioning。** namespace 模型为通用插件项目归属；当前真实写资格只绑定原 UI invocation。中央 Agent/Node 必须复用原宿主能力与真实权限通道，尚不能直接调用该内部 UI 写入口。
3. **旧 CreativeProject 查询的插件隔离。** 现有项目元数据查询没有因为新增 namespace 自动变成 plugin/project 范围；插件 CRUD、列表过滤和旧项目归属策略仍需后续绑定，不能默认将已有账号项目全归入某插件。
4. **项目文件面板与 workspace roster。** namespace 不提供文件根目录，也不自动改变原侧栏、活动工作空间或文件面板。后续需用原会话的 workspace binding 复用宿主文件能力，并按实际持久归属隔离展示。
5. **PostgreSQL 运行验收。** 已实现同连接与锁协议并通过 TypeScript 检查；当前没有 `CREWON_TEST_POSTGRES_URL`，相关行为测试全部跳过，未声称已验收真实 PG 并发或锁等待。

## 本轮验证

联合命令仅运行以下五个文件，未启动 App、服务、供应商请求或安装业务插件：

```bash
env PATH=/Users/cheneywang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:/usr/bin:/bin \
  node --experimental-strip-types --test \
  packages/domain/src/plugin-project-workspace-namespace.test.ts \
  packages/store/src/plugin-project-workspace-store.test.ts \
  packages/store/src/project-conversation-store.test.ts \
  packages/store/src/sqlite-run-store.test.ts \
  packages/store/src/postgres-thread-store.test.ts
```

结果：201 tests、15 suites；**185 passed、0 failed、16 skipped**。16 条跳过由 namespace PG 10 条（含新增 actual INSERT 后 policy deny/epoch change 的末端回滚负例）、原 Conversation PG 5 条和原 PostgresThreadStore 无数据库时的 conformance placeholder 1 条组成；placeholder 不代表完整 PG conformance 已运行。

新增 SQLite 测试通过原 PluginUiApplicationService 注册 lifecycle 和真实 SQL parent 执行，package verifier 与授权策略是明确命名的本地 fixture。8 项覆盖显式 migration、稳定归属与分页/冷启动、普通 create/fork 拒绝与原 binding 事务成功、binding 不匹配和最终撤权回滚、拒绝收养旧会话或借用他项目空间、伪造/完成 invocation 与真实 closeMount 后 INSERT 回滚、包升级保持归属与损坏 schema 失败关闭、真实第二 installation writer 在 Host preflight 与 transaction 之间禁用 selection。Domain 测试另覆盖严格 shape、不透明 ID、路径及 accessor 拒绝。

使用同一固定 Node 24 PATH 分别运行并通过：

```bash
pnpm --filter @crewon/domain typecheck
pnpm --filter @crewon/application typecheck
pnpm --filter @crewon/store typecheck
pnpm crewon:boundary:check
git diff --check
```

新增两个 PG 负例观察原 Client 的实际 INSERT 结果，再改变原 Host policy/epoch，断言原 invocation 失败且真实 namespace SQL row 为 0；只观察 UI 错误而不检查数据库回滚不能算通过。这两项当前因无 PG fixture 跳过，尚未取得实际运行证据。

上述 typecheck 均为 noemit；未构建共享 SDK/dist。185/16 是上述限定命令的结果，不表示整个 monorepo、生产安装、Native workspace 分配或中央 Agent 接线已完成验收。
