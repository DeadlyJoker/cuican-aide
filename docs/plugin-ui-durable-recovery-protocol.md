# 已安装插件原请求持久恢复协议

日期：2026-10-04。状态：协议、SQL 日志、网页/桌面 renderer 宿主和显式 Production Control 组装已实现并通过分层验证。正式 Main、Standalone、Native 进程入口尚未接线，完整应用重启流程仍未验收，不代表 S0 已完成。当前证据见[实施进度](./incremental-extension-progress.md)。

## 协议边界

新能力声明为 `crewon.plugin-ui-recovery@1`。它保存原请求及已经验证的回执，不负责执行模型、供应商请求或积分事务。旧安装包没有这个声明时继续使用原流程，不增加恢复读取或注册请求。新声明仍需要真实宿主服务组装、当前挂载、身份、档案、PDP 和批准的包/贡献/动作；声明和恢复提示都不能授予执行权限。

不改变原项目生成、查询和选用动作。注册只接受以下三个原 `{ action, input }`，包括原始幂等键、保存引用和全部 CAS：

| 原动作                                                        | 原执行结果                                |
| ------------------------------------------------------------- | ----------------------------------------- |
| `crewon.project-generations.v1.generateConcept`               | 原 Thread / Turn / Run 与插件积分准入回执 |
| `crewon.project-generation-queries.v1.queryConceptGeneration` | 原操作的独立查询 Turn / Run 回执          |
| `crewon.project-generation-selections.v1.selectConceptImage`  | 原 operation/resultIndex 的不可变选用回执 |

不接受客户端的账户、来源 pin、付款人、URL、phase、receipt 或新的请求键。准备 Thread 的原 `createThread` 不属于这三个动作；本阶段不能据此声称所有创建请求都已支持进程重启恢复。

## HTTP 与客户端

`GET /api/v1/plugins/ui/mounts/:mountRef/recovery` 不接收查询参数或请求体，返回该实际挂载 family 中每个动作的一条提示，优先未确认请求，否则取最新终态，最多三条。提示包含原 public source pin、原请求、记录 revision、`prepared/dispatched/accepted/refused`、派发次数、可能派发标记、匹配原请求的回执、retryable 和 reasonCode，不暴露账户或档案权威。旧包/档案的未知请求可以保留在提示中，不能替换为新来源重试。

`POST` 同一路径注册原请求，返回 `created/replayed` 和持久记录。这个 ACK 表示请求已保存，不表示任务或选用已提交。客户端严格配对原 key、CAS 和索引，使用原鉴权/Origin/CSRF/取消传输，GET 和 POST 响应均限制为 60 KiB，原请求限制为 24 KiB。网页代理仅允许这个确切 GET/POST 路径，不跟随重定向。

实际执行顺序必须是：注册请求并确认 SQL ACK，再调用原动作。注册网络结果不明或响应无效时，不调用原业务。晚到的注册只能留下提示，不能自动执行。原业务服务在执行前再次检查真实当前授权，并将派发次数持久提交；缺少注册时拒绝执行。相同原请求的显式重试可以重新注册并沿原动作重放，不能自动生成新键。

## 存储、归属与迁移

存储是原 Control 数据库中的三个独立表及显式版本标记，使用原 SQLite 或 PostgreSQL 连接。factory 默认关闭，不自动迁移。realm UUID 在显式迁移时生成并持久保存；账户归属为 realm、真实 tenant、space 和 principal。浏览器的用户 ID、临时端口、Origin 或 token 不作为持久账户命名空间。

原完整 admission pin 包括 actor、profile、包、贡献和动作。原幂等命名空间保留这些字段，不用新身份或新包替换；epoch 和 selection revision 保留审计，不能制造新的业务幂等身份。生成和查询的宿主恢复继续要求原完整 public source pin；图片选用保留同包重新启用后的既有五字段匹配规则。

每个账户最多 32 条记录。新增请求只能淘汰最早的 accepted/refused，不能丢弃未确认请求。同一 kind/plugin/contribution 的未确认请求阻止新 key，跨窗口、档案或包版本也不能绕过。相同 key 的请求体必须完全一致。记录序号来自账户 SQL 锁，不能依赖客户端时间排序。

注册与派发分别在同库事务内锁实际已安装 pin，并在 COMMIT 前复验调用存活和当前授权。PostgreSQL 复用借出的连接，支持 maxPoolSize=1，不在事务内再借连接；payload verifier 为同步纯函数，不调用网络或 SQL。身份与策略仍使用既有外部 authority fence，不能借恢复提示跳过当前检查。SQLite 在同步写事务前完成异步检查，并在 COMMIT 前保留同步 active fence。不完整或未知 schema 是错误，不能伪装为空记录。

## 未知结果与确认

新 Host 首次 ready 之前必须完整读取并恢复三个 lane。恢复加载失败时保持不可用，不用空 intent 掩盖错误。冷恢复的 prepared/dispatched 都显示 UNKNOWN，保留原输入和原 key，没有自动业务 POST。所有 lane 先校验、全部写入宿主快照，再通知页面，避免历史 accepted 覆盖另一个未确认请求的来源。

accepted 只能由原业务服务已经验证的、不透明提交事实确认，不能由浏览器写入。回执一旦确认不得回退；重放的 disposition 可以不同，但逻辑回执必须一致。图片的原回执与当前选用指针分开，当前状态仍需要单独读取。

refused 只用于图片选用第一次真实派发的四类明确提交前 CAS 冲突：项目 revision、素材 revision、operation revision、选用 revision。持久派发次数必须仍为一，且没有 accepted 或并发重试。已有 UNKNOWN 的重试、普通网络错误、生成和查询错误都不能据此宣称未提交。

原业务 COMMIT 与本阶段恢复记录确认属于两个事务。确认存储失败不能把已验证的业务成功改成失败；保留原成功回执并记录诊断，冷读取可能仍显示 UNKNOWN，需要显式使用原请求重放核验。因此本阶段不声称跨这两个事务的原子确认，也不能用存储层冷读取测试代替完整 Host / Control / App 重启验收。

## 验收范围

联合验收需要覆盖注册 ACK 丢失、执行回复丢失、实际进程重启、同 key 不增加原 Run/收费、三个 lane 的完整恢复、来源/账户/档案变化、并发窗口、晚回执、32 条配额、不完整 schema、单连接 PostgreSQL 和旧包零额外 I/O。随后在原完整及打包 App 中验证真实 Krea2 保存、生成、查询和选用路径，并保留原用户栏、设置、侧栏和共享样式。

真实个人身份、插件钱包、价格权威和第二个企业 API 仍按[实施方案](./incremental-extension-subsystem-plan.md)完成，不能使用具名测试夹具冒充生产资金或生产身份。
