# 桌面项目模型切换与登录核验

2026-10-09，正式 `/Applications/CrewON.app` 更新到 0.1.53。冷启动自动恢复原 `admin / 管理员`，没有输入密码、清除凭据或进入本机未登录模式；原项目线程、工作空间与会话保留。安装包签名与数据库备份完整性通过，15 个前端文件、Native Main、preload 和四份主题 CSS 保持。

在原小说项目的大纲阶段，选择 `gpt-6.1-sol` 后，0.1.52 在任务准备时返回 `extension_execution_target_mismatch`。原因是逐轮模型解析已找到正确的不可变模型版本，但共享的 Native 就绪检查仍只认可业务激活默认目标。

修复将同一真实请求所有者的业务激活准备与任务准备分开。业务激活仍固定原默认目标；任务仅接受当前 Native V2 已发布的精确模型兄弟目标，并前后复核原安装选择、插件字节、配置、真实 AgentVersion 和部署。旧发布、未发布目标、已撤回部署不能借此获得任务资格。委托计划执行也使用任务准备；请求缓存区分两种用途，不把激活就绪当作所选模型就绪。

新增真实 SQLite、Native 私有文件、原激活与安装选择、请求所有者、实际部署读取的回归检查。修复前，新增用例复现同一 `extension_execution_target_mismatch`；修复后通过。相关 30 项检查通过，包括冻结短剧 46 安装包的两项 Native 计划与冷恢复检查；Control 类型、架构边界、格式检查通过。具名离线 peer 的检查不替代外部模型执行验收。

安装后，通过原主页对话、原小说线程 `01a11bdd-9a83-778e-861f-3097a9462b19` 和大纲阶段执行只读核验。真实 Run `plugin-vbHX-RLTT81WE1ntfppZJ-lvORW1k_Js7cK8m0W5Dwk` 的持久化 AgentVersion 模型确为 `gpt-6.1-sol`；`crewon_short_drama__project_context_read` 成功，返回原阶段范围与小说大纲 Skill。模型在工具完成后的下一段请求返回 `responses_provider_invalid_prompt`，Run 已明确失败，没有调用 `outline_read`。因此不能记为最新 v6 大纲读取通过，也没有保存、采用、生成或启动计划。

证据在干净桌面验证工作树的 `output/extensions/desktop53-delivery/`：`package-proof.json`、`pre-install-backup-proof.json`、`account-and-task.png` 与 `actual-project-model-run.json`。正式短剧仍选中 45.0.0，46.0.0 已安装；未切换正在执行的插件、改写业务 SQL、重建冻结插件或重放原 Comfy 未知操作。

后续先查明该网关模型工具续接拒绝原因，完成真实大纲读取，再接通结构化候选写入、手动采用与跨阶段接力；完整 ReelBench 复刻验收范围保持。
