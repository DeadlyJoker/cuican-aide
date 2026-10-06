# 原对话的媒体输入任务入口

2026-10-06。此入口属于同一个短剧插件的原会话任务，适用于 T10 角色参考和 D18 分镜画面探索的输入准备。它不授予图片生成、供应商上传、候选采用或积分扣减权限；完整产品仍按[八阶段与双入口设计](./short-drama-product-experience.md)推进。

## 公开请求与回执

`GET /api/v1/threads/:threadId/project-media-input-stage` 返回严格的 `{available:boolean}`。先认证原会话访问，未部署时返回不可用；读取不创建任务，也不为调用者签发执行资格。

`POST` 使用同一路径、原会话认证/CSRF 和 `Idempotency-Key`。请求保存项目 ID、会话和绑定版本、原始用户正文，以及独立的 `media-input` 阶段：工作流、配置版本、需求版本和可选剧本引用。D18 必须指定采用的分集剧本；T10 可以只基于角色参考。客户端不能传入 actor、安装证明、工作空间或供应商路径来覆盖宿主身份。

服务读取当前会话绑定和工作空间、项目状态、需求版本、采用剧本及其大纲依赖。原 Application 将 Thread、Turn、Run、不可变阶段和回执一起提交。配置过期返回可刷新冲突；相同请求重试返回原 Run 和原阶段摘要，正文或来源变化不能借用旧键。已有任务恢复保留原来源，后来的手动新版本不被覆盖。成功提交才唤醒原 outbox，创建返回 201，重放返回 200。

## 安装与部署边界

`CreativeProjectCompositionConfig.mediaInputStages` 是独立的宿主部署开关，版本为 `crewon.project-media-input-stages.v1`。确切安装包和工作台 contribution 必须同时在原会话发布范围内；原文字/资产开关不会自动启用它。

原 Composer 的 HTTP 入口核验已安装 Short23 的 `crewon.project-media-input-tools@1` 声明、`media_input` 工具及其写权限/恢复策略、实际 Node 的 `project.execute` 声明、当前安装和发布授权。它编排包已支持的工具，不新增或冒充插件 UI 宿主服务，也不要求改写冻结 Short23 或 SDK。若以后让插件页面直接创建这种阶段，需要另行声明对应 UI 服务并接入该入口。

桌面 SQLite 与服务端 PostgreSQL 都借用原父 Store、TaskCore、身份与发布授权。显式启用时按依赖顺序建立原资产、媒体输入和阶段元数据表；这些迁移不部署资产写服务、供应商 I/O 或验证器，也不产生执行权限。关闭 owner 后拒绝新请求，并等待已经开始的请求结束。

## 当前验证与剩余接线

实际安装包经公开 HTTP owner 进入原任务与 RuntimeWorker：Agent 从项目、剧本及采用素材的实际工具结果组合输入，流式回复，原手动输入服务继续追加版本。SQLite/PostgreSQL 覆盖重复请求、丢失 HTTP 回执、丢失工具 ACK 后冷恢复、跨项目、过期来源、独立撤权、无部署和关闭。具名模型、身份/PDP、peer readiness 和既有参考来源是明确的测试边界；没有调用真实模型或供应商。

ControlClient 已提供 `projectMediaInputStages`。下一步把原 Composer 的阶段选择与发送逻辑接到该客户端，并按原 UI 覆盖实际页面、刷新/重启和插件工作台接力。HTTP/Worker 检查通过不代表用户 App 已更新，也不代表整套 UI 已完成兼容验收。
