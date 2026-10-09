# 短剧 Agent 结构化大纲与桌面读取核验

日期：2026-10-09。正式桌面仍为 0.1.53；以下结构化写入源码尚未接入 Worker 工具或发布新插件。完整短剧生产目标未完成。

## 正式桌面实际读取

解锁后确认原 `admin / 管理员` 登录态正常，同一小说项目、原会话和 CrewON 图片验收工作空间保持。通过主页共享对话框选择「大纲」阶段，以 gpt-6-astra 执行只读请求。

- 原项目：`01a11bdc-5df7-7113-bbbe-e736c43587a2`。
- 原线程：`01a11bdd-9a83-778e-861f-3097a9462b19`。
- 实际 Run：`plugin-S67THRb51a3H8GTnWyxR1SIbexP_krilNqiF017iibg`。
- 不可变模型版本：`native-plugin-agent-d8101480248e26292cade85e9a388e24a0e67b17fd01e6028e4f9d9842098117`；以原数据库中的 `agent_versions.definitionJson` 确认模型为 gpt-6-astra。
- Run 于 17:04:31 完成，桌面显示耗时 11 分 27 秒。

`outline_read` 返回原大纲最新候选 v6。第一次 `content_read` 参数错误被明确拒绝；Agent 随后纠正请求，通过两个分页读取全文，返回 `canonical-json / crewon.project-outline-document.v2` 和三集标题《来自明天的信》《渡船上的陌生人》《雾中的重逢》。四个工具回执均已结束，其中三个成功、一个明确参数错误；最终 Run 为 completed。

没有保存、采用、生成图片或启动计划。供应商续接慢仍需后续处理，不能将该耗时记为性能验收通过。桌面截图和原 SQL 查询证据保存在桌面验收工作树 `output/extensions/desktop53-delivery/actual-outline-v6-read.{png,json}`。

此前 gpt-6.1-sol 的真实 Run 返回 `invalid_prompt`。独立的惰性工具诊断也在首次请求被供应商以同码拒绝，另一次为供应商过载；没有形成工具续接的对比证据。因此没有改写 Agent 历史或增加通用拒绝重试。成功的 gpt-6-astra Run 是新请求，不代表先前失败已恢复。

## 已实现的结构化保存源码

新增独立的 `crewon.project-outline-run-commit.v2 / outline_change` 提交协议，绑定原 Run、工具输入摘要、ActionIntent、安装版本、项目阶段与队列租约。旧 `outline_save` 回执、手动 UI 协议、安装 pin 或普通回调不能替代它；模型不能指定幂等键。重试身份由原工具回执、执行及动作摘要派生。

Agent 和手动编辑共用原结构化文档变更、角色及分集 ID、版本头、正文与回执表。Run 输入另含 `expectedFoundationRevision`，新保存必须匹配 Agent 已读取的方案版本；同参数的新确认方案也不能被静默替换，原回执重放仍返回已保存事实。新增候选不会覆盖已采用的旧版大纲；Agent 不能借此自动采用或锁定。单次变更保持 48 KiB、最多十项的限制，不扩大模型上下文。

Application 提交辅助逻辑已抽离，保留事务内授权复核。SQLite 与 PostgreSQL 在原连接中检查实际 Run、Tool、安装、阶段、当前会话绑定和租约，并在最终提交前再次检查；内容必须对应原工具命令与确切 base。没有新数据库、运行时或迁移。

实际 SQLite 行为覆盖新增及分批变更、原已采用 v1 保留、冷重放、未知回执与新租约恢复、跨身份及内容替换拒绝、方案变化、会话撤销和最终租约失效整笔回滚。纯协议检查通过。PostgreSQL 没有配置测试环境，相应行为检查跳过，不能记为通过。

Node 24 / pnpm 10 的八个相关测试文件共 44 项通过、26 项 PostgreSQL 检查跳过。全部共享包类型检查、最终 Store 类型检查、架构边界与 `pnpm format` 通过。本轮没有宿主或插件页面样式变更。

## 下一步

接入 Worker 的独立结构化工具服务和协议声明，在单一短剧插件发布 `outline_change`，保留旧文字工具兼容。随后用安装包集成验证模型输出、候选保存、用户采用和原会话继续，再更新正式桌面及插件并验证真实外部模型写入。角色、美术、分镜、视频、配音、时间线和导出等后续流程仍待完成。

原不确定 ComfyUI 操作 `57bc1f09-34a9-7a29-585a-4db37f2f39df` 保留，未重提或用其它结果替代。
