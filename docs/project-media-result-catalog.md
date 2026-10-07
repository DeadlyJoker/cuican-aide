# 媒体候选目录与原任务来源

2026-10-07。接续[原媒体候选保存](./project-media-result-candidate-protocol.md)，新增可供原对话和同一个短剧插件工作台共用的有界候选目录。目录只呈现已经保存的结果，不把供应商文件位置当作项目候选，也不把生成结果标成已采用。

## 读取路径

`ProjectMediaResultCatalogApplicationService.listCandidates` 使用独立 `projectMediaResult:list` 授权和原 Actor。SQLite/PostgreSQL 原子存储在原项目锁内校验拥有者，分页读取最多 16 条候选及 1 条前瞻记录，并逐条重新验证原生成输入、Run、operation 和不可变来源。游标是确切候选 ID；排序在两种数据库一致。存储事务内逐条检查父存储存活、权限和取消；服务返回前再次检查授权与取消。

已有结果表通过 `enableCatalogReads()` 只校验、不开迁移；独立的目录开关不启用原候选写入或发布接口。没有历史 schema 的宿主不能通过读取请求创建表。保存、原结果读取和既有迁移保持原行为，未修改数据库表或记录格式。归档项目仍可以读取获准的历史候选。

服务返回项目、候选、原 Run、执行 ID、输入修订、工作流用途、PNG 尺寸、字节摘要及冻结时间，不返回 Actor、包内部信息、归档地址、供应商地址或凭据。目录表示“已记录”，当前图片是否可读取仍需原冻结字节读取服务验证。

## HTTP 与客户端

显式提供服务的 Control API 注册：

```text
GET /api/v1/creative-projects/:projectId/media-results?limit=16&afterCandidateId=...
```

`limit` 默认 16，可选 1–16。未知、多值、空或畸形参数被拒绝。不注册 HEAD，不要求生成 CSRF，不允许借读取发布新结果。响应最多 64 KiB，使用 `Cache-Control: no-store`。

原 `ControlApiClient.projectMediaResults.listCandidates` 保留身份、来源和取消，编码项目路径，不重试、不跟随重定向。Host 明确注入目录服务后才开放路由；未注入时原行为不变。这个服务并未自动加入桌面 Native 配置，后续装配必须提供当前请求对应的独立目录授权，不能把生成资格直接当作目录授权。

## 验证与下一步

验证使用实际 Short21 安装工作流的原 Run/operation、真实 SQLite/PostgreSQL、加密 PNG 候选、认证 HTTP 和原 Control Client；供应商响应、DNS、部署审查和授权策略为具名测试夹具。覆盖 T10/D18 原来源、分页、同拥有者不同 Actor、跨租户/空间/项目/拥有者拒绝、取消与关闭等待、冷读取、schema 不隐式迁移及响应边界。检查记录位于 `output/extensions/checks/media-result-catalog-20261007/`。

本次没有 UI 或主题改动，不覆盖或重打完整插件包、SDK 和用户 App。目录 HTTP 是显式可装配的能力，尚未完成正式 Native 装配、插件页面入口和 Agent 工具接入。接下来继续接原结果发布/读取入口、候选采用与锁定，再推进 Agent 有界自动执行、结构化分镜及后续视频、声音和成片。完整目标保持进行中。
