# 项目对话与阶段 Agent 协议

日期：2026-10-06。独立协议为 `crewon.project-conversations@1`（UI/原对话入口）和 `crewon.project-context@1`（Node 只读运行范围）。它们增量接入原 Thread、Turn、Run、Worker 和项目成果服务，不修改 SDK0.1.0、旧 Task2 请求或历史插件包。完整多阶段产品与后续计划见[协同设计](./short-drama-agent-workflow-design.md)。本协议先覆盖讨论、需求、大纲、分集剧本；不代表跨阶段自动推进或媒体已接通。

## 对话界面的统一约束

所有真实 Agent 对话复用主页现有对话界面及能力。插件通过宿主公开的会话入口打开实际 Thread，由宿主提供 Composer、模型选择、附件和上下文、Skill/MCP、权限、流式输出、停止与恢复。插件只增加有界业务上下文、阶段工具和产物视图，不另建聊天输入框、模型请求通道或会话历史；复用界面不扩大执行权限。短剧各阶段与主页操作同一会话及同一份项目产物。纯需求表单、产物编辑器不冒充 Agent 对话；演示聊天在接入真实 Agent 时也必须遵守此约束。

Short36 的「开始与 Agent 对话」调用原创建接口，收到真实绑定后立即打开原宿主对话；「新建项目对话」仍保留先创建后手动进入的行为。已有项目直接继续实际绑定的对话，流程和产物按需展开。

## 升级后的原会话恢复（Short32）

旧关联继续固定原安装来源。新版本工作台只读打开遇到明确的 `project_conversation_source_mismatch` 时显示“更新关联并进入”；普通断网或权限错误不触发来源变更。用户点击后，通过已有 `refreshSource` 保存下一关联修订，再通过原 `openConversation` 路径进入同一 Thread。项目、工作空间与历史 Run 均不迁移或重建。

更新丢失响应时保留原输入、关联 CAS 和幂等键，显式重试不能替换请求。更新中、未知结果以及物理写入未结束时禁止重复更新、创建或打开。模块撤回或切换后的迟到响应不能导航。确认更新后打开失败不重新提交更新；新模块挂载可通过读取和打开已保存关联恢复。此改动不新增跨 App 的未确认请求日志。

宿主验证刷新回执的完整当前包来源后通知原 Composer 重新读取，通知本身不导航或执行。协议、原会话创建、普通打开的只读语义及旧 SDK 保持兼容。Native 真安装与 SQLite 冷恢复验证旧包升级、原关联标识和 Thread 不变、原键回放与旧 CAS 拒绝；独立 ESM 的检查与快照覆盖显式恢复和未知响应。

## 同一个项目的两个入口

Short16 工作台在项目概览增加“与 Agent 创作”，从实际项目读取关联对话。用户明确新建对话时，保存宿主提供的创建工作空间；缺少工作空间提示时禁用创建，显式 `null` 表示未分配。不能借用当前随意打开的会话或改变其工作目录。创建不会自动跳出编辑器，用户通过“进入对话”打开原宿主聊天页。大纲/剧本页保留小型“项目对话”返回按钮，完整卡片不挤占正文编辑区。

一个项目可以有多条对话，一条 Thread 只关联一个项目。Thread 与项目关联在同一实际数据库连接中创建，保留原工作空间准入规则。Short20 通过独立[当前会话关联协议](./plugin-project-conversation-association-protocol.md)明确关联用户正在讨论的既有 Thread，不改变原创建方法；沿用该 Thread 的实际工作空间、版本和历史。只读打开不创建 Run。原 Renderer 校验服务回执、当前模块及实际 Thread 后，走原会话导航和加载路径。

原 Composer 在关联对话中显示当前阶段与分集选择。用户发送的原文作为真实消息保存；宿主从当前主体、关联、安装及已发布执行配置派生准入，模型不提供权限。需求追加当前修订，大纲/剧本进入与手动页面相同的候选和历史，采用/锁定仍由用户在工作台明确操作。

## UI 公共服务

公开入口是 `@crewon/contracts/project-conversations`。七种动作严格使用 `crewon.project-conversations.v1.*`；客户端捕获原 `services.invoke` 和严格 codec，不自动重试写入。

| 方法                 | 输入与作用                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `getBinding`         | 实际 `threadId`；查询原 Composer 的关联或 `null`                                           |
| `listConversations`  | `projectId / afterThreadId / limit`；按 Thread ID 有界分页，limit 1–16                     |
| `createConversation` | `projectId / workspaceId / title / idempotencyKey`；原子创建真实 Thread、关联和回执        |
| `openConversation`   | `projectId / threadId`；只读验证既有对应关系                                               |
| `refreshSource`      | 项目、Thread、预期关联版本和原键；显式更新后续 Turn 的完整安装来源                         |
| `setState`           | 项目、Thread、预期关联版本、active/revoked 和原键；改变后续执行资格                        |
| `startStage`         | 项目、Thread、预期 Thread/关联版本、原文、原键和具名阶段；沿原任务准入创建一次真实阶段 Run |

关联投影只包含稳定 ID、项目、Thread、工作空间、版本、状态、公开包来源和时间；不返回主体、私有准入或数据库句柄。公开包来源包含 pluginId、publisherId、version、packageDigest、selectionRevision。

输入和响应最多24 KiB；`startStage.content` 最多16 KiB UTF-8，Short16 的实际 task schema 还限制为9999 UTF-8字节。严格校验字段、JSON、ID、修订、游标和响应对应关系；调用者不能增加 actor、grant、pin 或执行路由。创建/变更返回 committed/replayed 和关联，启动返回真实 Thread/Run 版本与 stageAdmissionDigest；不伪造旧 Task2 的 messageId/configurationRevision。

原聊天 Control 接口新增：

```text
GET  /api/v1/threads/:threadId/project-conversation
POST /api/v1/threads/:threadId/project-conversation/stages
```

POST 原幂等 Header 必须与正文原键一致。Control/BFF/Native 保留现有主体解析、CSRF、运输及响应解析规则。普通 Turn 在原回放之前检查真实 Thread 关联；配置缺失或撤销不能降级到无项目范围的普通 Agent。

## 每轮固定的阶段范围

阶段是显式 discriminated union，不从提示词猜测：

| 阶段       | 必需输入                                           | 允许写入             |
| ---------- | -------------------------------------------------- | -------------------- |
| discussion | 当前项目与关联                                     | 无，讨论和读取       |
| brief      | 确切 briefRevision                                 | 追加创作需求         |
| outline    | 确切 briefRevision                                 | 保存大纲候选         |
| script     | episodeId、briefRevision、确切 outline 修订或 null | 保存指定分集剧本候选 |

每轮还允许本项目的头、历史和确切不可变正文读取。正文仍按1024 Unicode码点分页，工具完整结果最多8192 UTF-8字节。旧稿可作为修订参考；script 阶段读取或写入剧本时额外限定指定 episode。实际存储核正文类型与分集，不能只信工具参数。

阶段 Run 冻结关联修订、完整安装来源、原用户内容摘要、需求/大纲来源摘要和真实 Task/Extension binding。讨论、需求、大纲、剧本都不能在该 Run 新建其他项目、列出任意项目、采用/锁定成果或提交媒体。插件的 context 读取是信息投影，不能授予执行；宿主在实际工具命令与提交事务独立检查项目、阶段、来源及权限。

Node 通过 `@crewon/contracts/project-context` 的 `PluginProjectContextService.readScope({command})` 读取当前范围。必须是实际 Worker 派发的当前命令，复制命令、过期租约或 setup 期间调用无效。新工具 `crewon_short_drama__project_context_read` 返回该有界投影；其他工具也先读取并检查范围。真实旧无阶段 Run 返回 null，保留历史执行行为；新阶段 Run 的行或标记缺失必须拒绝，不能当成旧任务。

## 原子保存与恢复

Thread 创建、关联和命令回执同事务保存；阶段 Turn 的原消息、Run、队列、原 Task admission 和阶段 admission 同事务保存。SQLite 和 PostgreSQL 使用实际父 Store 的提交连接，保留旧 JSON 与摘要形状。原 Thread 和原 Task 表各有独立私有标记，防止删除新业务表后绕过阶段要求。

原键回放先读取原已受理记录，再决定是否冻结新来源。业务上游后来被手动修改，原已提交请求仍恢复原 Run 与原来源；新的请求必须核当前来源。关联升级/刷新只作用于后续 Turn，不改历史 Run。实际 COMMIT 后关闭不能把真实成功回执改成未提交。

工作台创建丢失回执时保留原 workspace、输入和 key，明确重试原请求；宿主提示变化不能改写它。已确认创建后的列表读取失败不改成未知。Composer 的未确认阶段发送在当前 runtime 保留完整原输入和原键，真实回执后重新加载失败只恢复原 Run，不再次 POST。阶段发送的未确认本地意图尚未增加独立跨 App 重启 journal，不能用服务端同键回放证明任意本地未确认草稿可冷恢复。

撤销关联、当前安装/配置不匹配或权限撤回后，拒绝新 Turn 和新工具写入。恢复原任务也使用原 Run、原包和实际权责范围，不把新安装当作历史授权。原 Krea2 operation 的未知受理仍只查询，不因项目对话功能重新提交。

原有报价准入另作输入兼容：聊天 binding 冻结原文摘要，实际 task input 是严格 `{prompt: 原文}`，两者不能混用。旧 `quoteGeneration` 四字段及 canonical input 校验保持不变；具名可选 `quoteProjectConversationGeneration` 附实际阶段 admission，核对原文、Task、binding、主体与来源摘要。远端须显式声明 `projectConversationQuotes.version = crewon.project-conversation-credit-quote.v1`，才提供新方法并发送带该 schemaVersion 的独立报价请求。没有新能力或外部服务未支持时拒绝，不调用旧报价方法作隐式回退。原回执/资金事务形状不变；本轮只解决已有准入兼容，积分产品、定价与钱包界面仍按用户要求后置。

新报价正文精确为 `schemaVersion`、`actor`、`binding`、`input`、`commandRequestDigest`、`projectStageAdmission`，`input` 精确为 `{prompt: 原文}`；内部 JSON 预算最多64 KiB，HTTP 响应最多16 KiB。响应沿原三字段 `poolId`、`priceRevision`、`quotedCredits` 严格校验。部署只有显式配置新版本后才可发送此正文，不能将阶段元数据塞入旧四字段请求。

## 独立插件构建与验收范围

Short16 在包内保存两份无 import portable 协议与两个公开 codec 的自持 ESM，构建固定 SHA-256；继续通过原 SDK 服务传输。UI/Node 都只使用公开端口。宿主明确准备/批准16的实际包后才能执行，服务声明或版本号本身不授权。

插件行为和真实 Chrome 的模块布局使用明确公共 DTO 夹具；实际 Thread/Run/Tool/安装/SQLite/PostgreSQL、Worker 流式与恢复由宿主集成分别验证。实际用户 App、在线模型、媒体和最终短剧交付另验收，不以夹具或已有生图单项推断全流程可用。当前检查与剩余工作见[实施进度](./incremental-extension-progress.md)。
