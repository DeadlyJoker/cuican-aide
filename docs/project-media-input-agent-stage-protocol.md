# Agent 媒体输入准备：原会话阶段范围

2026-10-06。状态：内部任务入口与 SQLite/PostgreSQL 保存、恢复已实现。[媒体输入工具宿主服务与原执行资格](./project-media-input-agent-tools-protocol.md)已实现；Short23 的插件 Node 工具与实际安装调用已验证；生产装配、原 Composer 入口与联合验收尚未接通。接续 [Short22 手动输入页面](./project-media-input-page-protocol.md)，遵循[双入口产品交互](./short-drama-product-experience.md)。

## 用户场景与本次边界

目标是用户在原对话说“用已采用的角色参考准备四视图”，Agent 读取同一短剧项目，整理提示词并保存确认输入；工作台随即可以继续编辑或执行这份输入。D18 则需要已采用剧本、场景和两个有序角色。准备输入、调用外部生成、采用候选各自有明确授权和完成依据。

本次先固定输入准备的任务身份和允许范围。新增内部 `createProjectMediaInputStageTurnFromHost`，复用原 Thread/Turn/Run、消息、工作空间和队列事务；没有第二套 Agent 引擎或聊天页面，也没有增加外部生成请求。它当前不能通过公开页面或模型工具直接调用。

## 独立范围

`crewon.project-media-input-stage-run-admission.v1` 冻结真实 actor、项目会话关联与修订、工作空间、确切插件安装、原 Run、配置修订、工作流、需求版本和可选剧本版本及摘要。T10 可以没有剧本，D18 必须指定剧本及所属集。

允许的范围限于输入元数据准备和原项目、文字、资产读取。`media_input` 宿主服务处理原任务范围、配置目录、输入目录、输入读取、分段提示词读取和保存；保存必须匹配本阶段的项目、工作流、配置、需求和剧本。完整引用及当前已采用素材仍需由共享媒体输入服务检查。这个范围不授予素材上传、外部生成、候选采用、锁定或其他阶段写入。

宿主提交需要独立 `crewon.project-media-input-stage-commit.v1` authority；现有页面 invocation、资产阶段资格或生成资格不能替代它。专用工具 owner 已实现独立服务资格和原 dispatch 核验；Short23 的实际包声明及工具调用已验证；部署批准和生产装配仍待连接，外部 PDP 判定使用具名夹具。

输入准备只接受已有的 unmetered 授权。缺失时在报价和写任务之前拒绝；原收费任务行为保持，积分没有扩展。

## 同一事务与恢复

独立迁移在原数据库添加阶段表与原任务 admission 的可空摘要列，不改旧阶段版本，不自动启用工具。父库事务同时保存原 Turn、Run、不可变阶段和摘要；其中任一步失败全部回滚。旧无阶段任务继续使用原读取和保存路径。

新建任务在同一事务核验当前项目会话、工作空间、安装、需求及已采用剧本。剧本引用的大纲后来改变，同样拒绝建立使用旧来源的新任务。相同请求恢复已提交任务时返回原 Run 和原来源；不把后来采用的内容替换进旧任务。

缺失阶段记录、标记不匹配、未知或不完整 schema、混用其他阶段均拒绝。提交前撤权回滚；数据库已确认 COMMIT 后的晚撤权保留本次真实成功，之后的新请求仍重新授权。

原 Core 把新增方法纳入受管理的 mutation 生命周期；关闭后的调用不能进入任务服务。Worker 当前识别到这种真实阶段会返回明确的 `installed_plugin_media_input_stage_runtime_unavailable`，避免在专用工具尚未连接时降为普通、不受阶段约束的 Agent 任务。

## 验证与下一步

检查使用真实原 Application 任务入口、SQLite 文件、正常持久性配置的 PostgreSQL 与原队列事务，覆盖 T10、D18、跨连接读取/恢复、过期来源、安装/会话边界、回滚、晚撤权、缺失记录、原收费及 unmetered 兼容。Worker 检查读取实际保存的阶段并拒绝错误分派；这些检查不运行模型、ComfyUI 或新 Agent 工具。

证据在 `output/extensions/checks/project-media-input-agent-stage-20261006/`。原 SDK、Short22 及更早完整包、App 保持冻结，本次没有更新用户 App。

Short23 已增加同包真实 `media_input` Node 工具并验证实际安装调用。接下来连接原 Composer/Worker 的独立服务授权，再验证“对话保存 → 页面读取与编辑 → 对话继续”及流式/中断恢复。随后接实际媒体生成、查询、候选采用和有界跨阶段计划。结构化分镜、视频、声音与成片仍按完整八阶段方案继续，目标保持 ACTIVE。
