# 确认媒体输入与原 Run 的事务关联

2026-10-06。状态：宿主内部媒体 Run 准入、[Worker私有上下文与字节检查](./project-media-worker-context-protocol.md)及[候选原请求占用](./project-media-operation-protocol.md)已补齐。真实 Tool 提交/查询、公开 Main 服务和手动/Agent 入口继续接线。沿[双入口编排规格](./short-drama-orchestration-spec.md)推进，一个 `crewon.short-drama` 插件包含多个工作流。本文不发布新的 SDK 或 HTTP 请求。

## 执行身份

[确认输入](./project-media-input-protocol.md)保存提示词、工作流、业务项、确切来源和目标修订；原素材准备 journal 保存实际上传及字节观察。新的宿主资格服务仅观察已经准备的素材，不上传、不生成；全部角色当前 verified 后形成 `crewon.project-media-generation-reference.v1`。

引用固定项目、输入 ID、输入修订、预期 head、输入摘要、工作流和业务 `executionId`，以及每个有序素材的原 intent、初始摘要、事件修订与事件摘要。T10 一个角色，D18 场景/角色一/角色二；D18 的两个角色实际源字节相同也拒绝。

`executionId` 表示一次明确候选意图。同一意图不能因另一入口、另一请求键或另一 Thread 创建第二个 Run；明确“再生成一张”才使用新意图。原键重试仍返回原结果。这是媒体单项底座，尚不替代待实现的跨阶段步骤领取。

宿主专用 `createProjectMediaTaskFromHost` 复用原 TaskCore，使用独立 `media.generate` action 与 `crewon.short-drama.reference-generation.v1` 输入。原 Run 消息只含业务选择器和摘要，不含提示词、图片、供应商路径或凭据。后续 Worker 必须从真实已接受关联解析这些内容；模型自填文件名不能建立素材资格。旧概念 `{prompt}` 任务保持原契约。

## 同一个原 Turn 事务

显式独立迁移建立不可变关联及有序素材索引，外键指向真实输入修订、准备初始记录/事件、原 binding、admission 和 mutation receipt。构造不迁移，必须复用已显式启用的同一 ExtensionStore 实例；缺表、marker 或 SQL 保护损坏时拒绝。

SQLite/PostgreSQL 在原 Turn 的同一连接和项目锁内核验输入 head、当前采用来源、安装/选择/配置、工作流及真实准备历史，然后写入原 Run、消息、队列、资金准入、回执和媒体关联。没有第二套任务执行器，也不在事务中读取文件、DNS、HTTP 或借第二个 pool 连接。PostgreSQL 单连接池回归通过。

`projectMedia:generate` 是独立用途；输入读写、准备上传、目标观察和旧文字执行资格不能代替它。事务前及适用的事务检查点核对 PDP，SQL 每步前后及提交前核对 owner/profile 活动。SQLite 异步资格在 BEGIN 前完成，锁内只做同步活动检查。事务内撤销活动时全部新 Run、资金及关联回滚。

新任务在报价前和派发前实际观察各目标副本，核对原事件、字节和输入。远端字节与本地 SQL 无法成为同一个原子事务；Worker私有再次字节检查已补齐，与真正Tool/供应商IO边界的接线尚待验收。当前 Run 准入不能单独作为已生成媒体的证明。

原显式不扣积分模式继续走原 unmetered 准入；此次没有设定插件价格。对应回归断言无报价、无新积分 hold，冷恢复保持。原已计费任务兼容回归也保持，积分产品设计继续后置。

## 接受后重放与新执行

`crewon.project-media-generation-link.v1` 固定原 actor、输入/素材引用、原 Run binding、实际 task admission、原回执与整体摘要，完整记录不超过32KiB。历史读取同时核对物理索引、原输入修订、原 binding/admission/receipt 和真实材料事件摘要，不把客户端 JSON 当作接受证明。

接受后原键重放只核对原关联和当前用途/活动资格，不重新准备或读取远端字节，不因上游已变化而创建替代 Run。冷恢复沿实际数据库读取原输入和关联。新候选另核当前 head、来源、安装和实际目标字节；历史 verified 不替代当前可用。原任务后续观察与媒体结果回写将另接 Worker，不能把此处的历史读取当作供应商恢复。

## 验证范围

相关回归 **190/190** 通过、零跳过；新增34项双库检查是其中子集。覆盖 T10/D18 同一原 TaskCore、并发原键、业务意图唯一、明确新候选、源/head/目标变化、报价后撤权、事务内活动撤销、伪材料事件、旧普通任务绕过、显式迁移、不可变历史、冷恢复、描述符拒绝及不扣积分模式。原任务、项目对话、资产及文字计划也回归通过。

项目、数据库、原 Run、PNG 字节、加密归档及准备历史是真实执行；安装清单、PDP、DNS、供应商响应和报价为具名夹具。本轮没有新的远端供应商生成调用，没有更新完整插件包、用户 App 或原前端；不能作为真实模型、Main/正式桌面和媒体完整流程验收。

初始迁移实例误用、类型/方法覆盖和错误码期望不符的失败日志保留；修正实际实例及精确期望，没有放宽 SQL、字节或权限检查。证据位于 `output/extensions/checks/project-media-generation-run-20261006/`，各轮自有 PostgreSQL 正常停止并按目录身份清理。Application、Store、Runtime-worker、Control 类型及架构边界检查通过。旧 SDK、完整插件包和 App 的保持核验另附该目录。

接下来按原顺序接 Worker 解析与真实提交、原结果候选回写、手动和 Agent 共用媒体命令，再做结构化分镜及有限跨阶段计划。视频、声音和合成逐项核验实际 API。完整目标继续 ACTIVE。
