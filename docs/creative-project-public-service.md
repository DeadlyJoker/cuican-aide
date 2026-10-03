# 短剧项目公共元数据服务

2026-10-03：S0 项目、创作需求及概念图输入修订可通过 Control HTTP、同源 Web BFF 与 ControlClient 保存、分页读取和冷恢复。此步骤提供数据服务；安装插件的 SDK/Host action、正式工作台保存、生成关联及结果选用尚未接线。

## 显式装配与权限

Standalone 与 Production 配置可显式传入 `creativeProjects: { authorization }`，策略必须实现 `CreativeProjectAuthorizationPort`。装配捕获并绑定可信策略的方法，在真实父 Store 上执行独立项目迁移。未传配置时不访问项目 adapter、不迁移、不注册项目路由；同步 Standalone 创建器拒绝这个异步选项，使用新增 `createStandaloneControlApiWithCreativeProjects` 或现有异步装配入口。

HTTP 通过原 `ControlApiIdentity` 解析真实当前 actor，Application 再核对当前授权及 tenant/space/principal 归属。项目首先限创建者本人，同空间其他 principal 也不能访问。客户端不传 owner、actor、tenant、space 或授权策略。公开 DTO 不包含这些私有字段。Production 继续要求真实 `ProductionControlApiIdentity`；测试提供的身份与策略不代表线上账号服务。本机管理授权也不产生付款许可。

当前项目种类固定为 `short-drama`，存储归属是 tenant/space/principal，并没有 plugin/profile/package namespace。此服务不能被宣称为任意第三方插件的数据隔离协议。正式插件入口仍须经原安装、模块启用及 Host action 权限边界接线。

## HTTP 契约

公共前缀为 `/api/v1/creative-projects`，只开放下表中的 14 个操作；读取路由不隐式开放 HEAD，未知方法或路径拒绝。

| 相对路径                                                 | 方法      | 用途                       |
| -------------------------------------------------------- | --------- | -------------------------- |
| `/`                                                      | GET, POST | 分页项目列表、创建及首需求 |
| `/:projectId`                                            | GET       | 项目元数据                 |
| `/:projectId/title`                                      | PUT       | 按预期版本重命名           |
| `/:projectId/state`                                      | PUT       | 按预期版本归档或恢复       |
| `/:projectId/briefs`                                     | GET, POST | 需求历史、追加不可变修订   |
| `/:projectId/briefs/:briefRevision`                      | GET       | 确切需求修订               |
| `/:projectId/concepts`                                   | GET, POST | 概念资产列表、创建首修订   |
| `/:projectId/concepts/:assetId`                          | GET       | 概念资产元数据             |
| `/:projectId/concepts/:assetId/revisions`                | GET, POST | 输入历史、追加不可变修订   |
| `/:projectId/concepts/:assetId/revisions/:assetRevision` | GET       | 确切输入修订               |

OpenAPI 为这些操作新增独立 schema 与项目幂等参数，原 HTTP 契约保持原义。请求严格检查允许字段及 query，不接受客户端身份字段。所有写请求要求原认证、Origin/CSRF 与 `Idempotency-Key`，修改或追加还要求明确预期版本；相同键和相同输入返回原回执，相同键改输入返回冲突，记录与回执在原父数据库事务中提交。归档禁止新创作，保留历史读取、重命名和恢复。

幂等键最多 128 个 UTF-16 单元，不能有边缘空白、控制字符或逗号；拒绝 HTTP 层将重复头合并成的逗号列表，不放宽原其他路由的幂等契约。ID 最多 128 个 UTF-16 单元，须为有效 Unicode，无边缘空白或控制字符；客户端只编码一次路径段，完整 `.` / `..` 拒绝。原 canonical identity 可长至 512 字符，而现有项目领域 ID 上限为 128；超过项目边界的真实身份会拒绝，不截断或自行映射。

需求最多 8KiB UTF-8，保留实际文本；标题和概念名最多 160 个 Unicode 字符，生成描述最多 2,000 个 UTF-16 单元。概念修订冻结确切需求版本及摘要。输入修订不表示图片已经生成；接口没有 Run、付款、供应商、任意 URL 关联或选用命令。

## 分页、响应与客户端

列表默认 20 项、最多 50 项，每次响应最多 60KiB。服务按完整记录裁掉末尾项以满足字节上限，不能截断不可变需求文本；继续游标取实际最后返回项，避免跳过被裁掉的记录。

项目列表按 `updatedAt` 与 `projectId` 降序，用状态绑定的规范 base64url 游标。需求与输入历史按修订号继续，概念资产按资产 ID 继续。子列表 continuation 允许继续读取，不承诺精确 `hasMore`；满页后可能读到最后一个空页。客户端不能以本页数组长度推导全部历史。

`ControlApiClient.creativeProjects` 挂载 14 个类型化方法，复用原认证、CSRF、幂等和有界响应读取，手动处理重定向。专用客户端默认 30 秒期限，可配置 1–60,000ms；捕获同一个 caller signal，期限到达或取消后不发布迟到结果，并清理 timer/listener。该期限是项目客户端新增约束，不改变原通用传输的行为。

BFF 只代理明确项目路径和方法，在 URL 规范化前检查原目标，防止编码或点路径落回通用代理。请求最多 64KiB，正常和错误响应都最多 60KiB，期限 10 秒；继续使用原 session、身份头剥离及 CSRF 机制。它不改原 SSE 或插件任务代理。

## 每次调用的提交检查

可信 Host 可给 Application 的六个写用例传入独立可选提交 authority，Store 在实际 COMMIT 前核对本次调用。关闭、过期或已经观察到的撤权使未派发的提交整笔回滚；已确认 COMMIT 保留成功和原回执。此选项不进入 HTTP、schema 或持久输入，缺省公共调用保持原行为，不承诺远端权限和数据库的全局原子性。具体时序与 SDK 动作见[安装插件项目协议](./installed-plugin-creative-project-actions.md)。

## 验证边界与下一步

严格契约、客户端取消/期限、实际 SQLite 与 PostgreSQL HTTP、可选装配及真实 BFF→Control→SQLite 验证覆盖保存、不可变历史、账号隔离、撤权、并发 CAS、丢回复重放、归档、分页字节裁剪、回执失败回滚及同库重启恢复。PostgreSQL 验证使用隔离的本机 18.6 实例；具名测试身份不代替生产账号和钱包。

安装插件动作协议、SDK helper 和可信调用提交检查已实现；下一步将同一公共服务接入明确 Host dispatcher、实际依赖可用性和 ready，再连接模块内的项目界面。生成关联仍需加入原 Run/个人积分冻结事务，结果选用只能引用已核验的原 operation。保留原用户栏、设置、侧栏、普通聊天和团队页面，完整 S0 门槛见[产品方案](./short-drama-workbench-product-plan.md#实施与验收顺序)。
