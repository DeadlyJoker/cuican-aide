# 原 Agent 会话关联短剧项目

日期：2026-10-06。Short20 增加独立可选协议 `crewon.project-conversation-association@1`，让用户把正在讨论创意的原会话关联到已经创建的短剧项目。原 `project-conversations@1` 七个方法、SDK0.1.0和旧发行包保持不变。完整产品设计见[Agent 与工作流协同方案](./short-drama-agent-workflow-design.md)。

## 页面行为

工作台沿原内容区、原组件和模块样式，在项目概览提供“关联当前会话”。宿主只向声明新协议的模块，在 `props.data.projectConversationAssociationThreadId` 传递当前 `selectedThreadId`（string或null）；缺少字段的旧宿主不显示当前会话关联入口。该值是读取提示，不是权限。打开模块、查看项目、切换会话、冷重开都只读取关系；用户明确关联后才能写入。

关联保留真实 Thread、原工作空间、全部消息、事件、模型历史和 Thread 修订；不另建对话、改目录、发送消息、创建 Run 或执行计划。原对话输入区通过当前客户端及 Thread 专属的本地读取通知，重新加载真实关系，沿原项目 Composer 选择讨论或已有阶段。通知不携带授权，不导航、不改变选择；其他会话和客户端不响应。

项目可有多条对话，一条 Thread 只属于一个项目。已经关联的会话先复用原关系；不覆盖原项目或借用当前全局工作空间。正在执行的会话拒绝新关联。新旧写入共享实际数据库锁，关联与普通 Turn 竞争时重新检查范围；关联前准备的普通 Turn 不能在关联后按旧范围提交。

## 独立公开协议

入口 `@crewon/contracts/project-conversation-association`，动作及输入如下：

| 动作                                                 | 严格输入                                                                 | 结果                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `crewon.project-conversation-association.v1.inspect` | projectId、threadId                                                      | candidate 为 null，或真实 threadId / threadRevision / workspaceId |
| `crewon.project-conversation-association.v1.attach`  | projectId、threadId、expectedThreadRevision、workspaceId、idempotencyKey | committed/replayed 和原公开 binding                               |

正文和结果最多8192 UTF-8字节；字段、JSON、修订、ID及返回关系严格校验。显式 null 表示该真实会话未分配工作空间。插件不能附 actor、grant、Run、安装 pin、执行参数或路由。宿主从当前原会话、主体、租约、确切已安装包、声明及项目读写权限派生准入；原服务协议或任意发行版本号不会赋予新权限。未知、错误版本及畸形命名空间成员由 metadata owner 拒绝，不回退到 Node 执行。

SQLite 和 PostgreSQL 使用原关联表、原 `kind:create` 回执及独立 attach 请求摘要，无数据迁移。事务内重核项目、主体、Thread 版本/工作空间、关联唯一性、当前安装和最终权限；实际 Run 和未完成 work item 都会阻止关联。新建关联必须附真实新建 Thread 提交或既有 Thread 的修订检查，不能进行缺少 Thread 检查的直接创建。普通 Turn 的实际提交事务也核原私有关联标记；原已验证项目阶段继续沿原扩展提交路径受理。

## 未确认回复与恢复

关联冻结原项目、Thread、工作空间、修订和 key。回复丢失后先读取实际关系；读到同一 active binding 即确认，不能因此另建对话或 Run。显式重试只使用原输入/key，服务器先回放已提交回执。切换会话后的旧回复不能写入新页面状态，未确认原请求仍读取原目标；确知原 Thread 修订或工作空间已经改变且尚无关联时，才允许重新确认。

冷重开读取真实 binding，不自动 POST。此次未新增跨 App 的关联意图 journal；不能声称未受理的本地关联草稿已经完整持久恢复。服务端同键回放和真实关系读取仍有效，后续用户显式操作受到原事务、唯一性和 Thread 检查约束。

## 实施边界

这是原对话到项目执行的一个衔接步骤。当前聊天项目建议仍只预填，需在模块明确创建项目、关联当前会话、选择执行范围；关联不会自动选择某个计划或开始制作。需求、大纲、剧本计划和资产单阶段沿已实现机制执行；从原对话直接确认创建、授权多阶段自动推进、设定/参考到实际媒体工作流、分镜、视频、声音和成片继续实施。

Short20 使用冻结SDK0.1.0仓外独立构建，把新增公开协议与校验器包含在同一个短剧包；没有私有宿主运行时依赖。旧19.0.0、19.0.1、正式桌面0.1.17/0.1.18及实际用户App/profile保留。新包与新桌面的正式联合验收须单独进行，源码/独立包测试不代表真实模型或公网媒体已验收。证明目录为 `output/extensions/checks/project-conversation-association-20261006/`。
