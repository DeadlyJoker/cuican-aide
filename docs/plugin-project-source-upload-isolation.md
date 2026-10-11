# 原小说上传源与恢复路径的负向隔离

本轮继续复用原 ProjectSourceUpload、Foundation、Run 和 CreativeProject Store。没有新数据库、项目管理器或执行器，也没有新增插件项目创建资格。检查只拒绝普通入口访问已保护项目及其实际关联的上传源。

## 实际检查的保存事实

同一原库中的 `project_source_upload_associations` 保存 tenant、space、principal、uploadId、projectId 与 source revision。普通上传状态、原始字节、解析结果、写入与准备操作检查该 uploadId 的全部实际关联；任一关联项目已有严格 metadata owner 时拒绝。

begin 重试使用实际保存回执的 uploadId。Foundation creation、proposal、update 与 confirm 回执使用解码后的实际项目与 source revision；当回执没有完整 source 对象时，仍检查它保存的 `foundation.source` 指针。不能用新的请求 uploadId、目标项目或空 source 替代保存事实。

来源复制通过原 borrowed adoption transaction 再查原上传 ledger。即使解析快照已在 owner 发布前取得，后续普通新建项目也不能据此复制保护源。现有副本不搬迁、不改写；读取该副本的旧来源或重放带来源的旧回执，同样检查上传源的实际关联。

原 borrowed downstream、Foundation Run facts、immutable Run admission 与 required digest 也检查保存的 source revision。保护命中是明确拒绝，不返回 null，不降级为没有 Foundation 的旧执行。冷打开和会话恢复保留原 Run JSON、marker、历史与 Tool 派生键。

## 原连接与事务

- SQLite 数据操作保留原 snapshot 或 BEGIN IMMEDIATE。实际 sidecar 检查、关联 SQL、原业务写入与最终检查在同一连接/事务。最后所有新增 SQL 完成后，再执行原完整 Run qualification、同步 active/open 检查与 COMMIT。
- PostgreSQL owned 数据交易显式 READ COMMITTED；borrowed helper 要求调用者已有同一实际 READ COMMITTED 事务。原 sidecar migration shared lock 与 inspection 在同一 client，首次迁移等待结束后的新 statement 能看到完整 schema。部分 schema 明确拒绝，数据读取不迁移、不修复。
- multipart reader 获得原 upload advisory key 的 shared transaction lock；原 ledger writer 仍获得同键 exclusive lock。多条 READ COMMITTED ledger 查询因此保留原 upload 的一致状态。
- saved source helper 从实际保存关联取得 uploadId，按稳定顺序获取同键 shared locks，再查保护关联，锁保留到原 outer COMMIT。原安装、业务 PDP、事务末端权限、同步撤权与物理 Run lease 均继续验证，新增 SQL 不放到最终租约之后。

当前生产 association 的唯一追加路径位于原 Foundation project lock 下，先校验 Foundation revision 并插入新的不可变 source revision，再在同一 COMMIT 写入 association。合法 replay 不追加历史 source revision 的上传集合。本实现依赖这一现有不变量；两次 SELECT 本身不构成集合幻读保护。未来如开放独立 association writer，须保留原锁次序并重新验证集合稳定性，不能倒转为 upload → project 锁顺序。

## 兼容与边界

完整旧 schema 且 metadata owner sidecar 完全缺席时，旧业务继续正常。完整 sidecar 但没有 owner 的旧项目仍可用。手工导入的旧来源在原 Upload schema 完全缺席时保留原读取行为；部分 Upload 或 owner schema 拒绝。原显式 schema 迁移没有生产启动回填，旧来源、关联、回执与执行记录保持原样。

原显式 DDL 迁移不因无关的 partial owner namespace 被拦截，也不迁移或修复该 namespace；实际数据操作继续 fail closed。真实测试保存了 partial owner 的原行与 schema 对象，重新执行 Upload/Foundation migrate 后仍保持原样，并验证状态、回执与新写入继续拒绝。

全部新增模块保持内部私有，没有公开 HTTP/JSON 字段变化、访问 grant、protected writer、owner adoption 或 renderer owner/path 输入。SQL 负例建立 owner 或关联只用于验证拒绝，不表示 Host 已签发业务资格。metadata owner 的生产创建、完整绑定管理视图、其他尚未接线的产物入口，以及 Main/Control/中央 Agent 的产品接线仍是独立后续工作。

## 验证范围

固定 Node 24，原 SQLite 文件数据库及 PostgreSQL 18.6 fixture；所有 owned pools/clients 由测试关闭，共享 PG fixture 不由本组停止。

- 新 Store 专项：10 项覆盖实际上传/副本/来源/回执拒绝、准备快照再次 admission、部分 schema、真实 shared upload lock 持有至 COMMIT、默认 RR session 等待首次 migration 后读取，以及 payload INSERT 后末端 SQL 撤权回滚。
- 新 genuine Run 专项：2 项使用原 Turn 签发的真实 admission，覆盖 borrowed facts、保存 admission、required digest 与冷恢复拒绝；原 immutable marker 不变。
- 新 Control 协议专项：2 项经临时数据库和原 Fastify mounted plugin action/raw upload 路由，覆盖真实安装检查、原业务策略和来源拒绝；独立 upload 继续可用。它是自动化原协议集成测试，不是实际浏览器 Web 或正式桌面验收。
- 原 Store 受影响回归与上述新专项共 212 项，最后完整组使用 `--test-concurrency=1`，SQLite/PG 全通过，零 skip。包括原 Upload schema/commit，Foundation schema/store/plugin/downstream/Run，以及前一组 legacy/snapshot 测试。保留原租约与 timeout，确保物理租约过期测试进入它要验证的末端检查阶段。
- Control 新旧协议、原 source adoption/adapter、20MB multipart 与 PDP 七文件共 56 项，SQLite/PG 全通过，零 skip。使用文件并发 1，保留原 timeout；原测试的 write-COMMIT observer 已适配显式 READ COMMITTED BEGIN，仍验证真实提交后撤权不会伪报提交失败。

窄命令在仓库根目录执行，PostgreSQL 使用测试专用 `CREWON_TEST_POSTGRES_URL`：

```bash
node --experimental-strip-types --test packages/store/src/project-source-upload-legacy-access.test.ts packages/store/src/project-source-upload-run-legacy-access.test.ts
node --experimental-strip-types --test apps/control-api/src/project-source-upload-legacy-access.integration.test.ts
pnpm --filter @crewon/store typecheck
pnpm --filter @crewon/control-api typecheck
```

本轮不部署、不更新正式 App、不安装业务插件。实际浏览器 Web 闭环仍须在后续产品 owner/资格接线完成后验收。
