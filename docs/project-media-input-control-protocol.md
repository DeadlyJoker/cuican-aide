# 共享媒体输入：Control 与原客户端

2026-10-06。状态：原 Control/Core 的显式元数据装配、HTTP 和客户端已实现；正式 Main 文件批准、插件页面服务、Agent 媒体工具及生成协调继续接线。沿[八阶段双入口方案](./short-drama-orchestration-spec.md)推进，复用[原确认输入](./project-media-input-protocol.md)、[Run 准入](./project-media-generation-run-protocol.md)和[实际 Worker](./project-media-worker-composition-protocol.md)。本项不会把保存输入当成素材准备成功或生成完成。

## 共享命令

新增独立 `crewon.project-media-inputs.v1` 逻辑元数据协议及原 `ControlApiClient.projectMediaInputs` 分组。宿主控制客户端可保存、读取确认输入；插件 UI 和模型还不能直接借此取得宿主凭据或执行权限。

| 方法 | 路径                                                              | 行为                                                    |
| ---- | ----------------------------------------------------------------- | ------------------------------------------------------- |
| POST | `/api/v1/creative-projects/:projectId/media-inputs`               | 保存新输入或追加确切修订；原 `Idempotency-Key` 在请求头 |
| GET  | `/api/v1/creative-projects/:projectId/media-inputs/:mediaInputId` | 读取当前修订                                            |
| GET  | 同上，`?inputRevision=N`                                          | 读取原不可变修订，同时返回当前修订号                    |

保存包含业务项、需求修订、可选剧本修订、工作流、确切配置修订、用户确认的提示词及逐角色逻辑参考。新输入使用 `mediaInputId=null`、`expectedInputRevision=0`；编辑既有输入必须给原 ID 和准确的当前修订。项目来自路径；调用者、租户、工作空间、宿主 profile、目标插件和实际来源绑定均由服务器判断。

目前这个协议只覆盖已核验的 T10 四视图及 D18 三参考分镜探索。T10 必须引用同一个实际角色；D18 必须给已采用剧本、场景和两个不同角色。D18 不被当作视频、最终结构化分镜或任意单人物镜头生成。后续其他媒体工作流沿各自的输入与输出契约接入，不悄悄改变这个 v1。

请求最多16KiB，提示词最多8192 UTF-8字节，响应最多24KiB。字段、角色和修订严格校验；未知字段、访问器、外来项目、非标准修订查询及跨角色复用同一资产均拒绝。公开响应只有逻辑引用和确切输入修订，不携带供应商 URL/文件名、profile、包身份、内部准备请求或凭据。客户端验证响应对应原输入，保持原认证/Origin/CSRF、显式原键、编码路径、手动重定向及30秒期限，不重试保存。

## 原宿主装配

原 `createInstalledPluginTaskRuntimeCore` 增加可选 `projectMediaInputs`，必须显式给 `crewon.project-media-input-control.v1` 批准：已核验工作流/包、独立输入读写目的 PDP、原项目读取 PDP、原安装读取 PDP 和实际结果校验器。旧配置没有该项时不迁移媒体输入，也不生成这个 owner。现有 UI、资产、文字或任务批准不隐含这一权限。

`InstalledProjectMediaInputRuntime.prepare` 只借用实际 Core、同一 SQLite/Pg parent 和原 issued request owner。Core、数据库或请求 owner 不能复制/替换；批准的目标必须属于原 Core 的固定 publication。实际来源通过这个 parent 的原项目、资产、采用参考、成功 Run/operation/result 读取；实际目标通过原安装选择与 Core 配置读取。没有从 Runtime-worker 导入产品实现，没有新运行时、数据库或流程引擎。

原 HTTP 会话、当前 profile 和独立目的在 await 前后以及原 SQL 事务检查中持续重核。保存只生成不可变输入修订和原回执，不开放 `qualifyInput`，不请求积分报价、素材网络 I/O、Run 或生成。GET 沿原项目/输入读取权限读取历史；合法原回执恢复也不要求重新选择目标或取得新的供应商准备权限。

相同原键/内容返回同一个原输入；键相同但内容变更拒绝。追加提示词不改变旧输入。HTTP 断连会撤销原请求信号；Core 关闭停止新调用并物理等待尚未返回的批准/事务，借用的 parent 不被该 owner 关闭。部分落库后的回执丢失仍以明确的原键恢复。两个业务入口各生成随机新键不能实现步骤去重，未来计划仍要共享原持久步骤/执行意图。

`buildControlApi` 只注册 genuine owner；原 standalone 装配从已准备的 Core 借它。**当前正式桌面 Main 文件协议尚未声明这一新批准，因此用户 App 不会自动开启入口。** 后续先声明和核验独立数据批准，再把插件 UI/Agent 指令接到这一 owner；素材准备、Run 受理、结果候选/采用分别沿原独立协议接线。

## 验证边界

173/173相关检查通过，零失败、取消或跳过，覆盖12份完整文件；新增协议/客户端/Control专项18项是其中的子集。真实 SQLite/Pg、原 TaskCore、issued request、原认证客户端与 HTTP 已覆盖 T10/D18、并发原键、修订/历史、失效来源、目的撤销、profile 变更、不同主体/租户/工作空间、冷重开、已保存原回执、配置注入及关闭等待。真实 loopback socket 还覆盖原客户端保存/读取，以及 HTTP 断连先撤销再拒绝事务提交。

这里的部署审核、PDP、原成功媒体记录及校验器是具名测试夹具。没有替换业务 SQL/事务或签发私有执行回执，也没有调用新的远端模型、图片 API、上传或生成。单独注册 HTTP 与原 Core 的可选装配得到验证；这不等于正式 Main/完整插件 UI/Agent 媒体链已经交付。积分后置，完整目标保持 ACTIVE。

证据：`output/extensions/checks/project-media-control-inputs-20261006/`。三组均使用自有实际 PostgreSQL，保持 `fsync/full_page_writes/synchronous_commit=on`，正常停止后按目录身份清理。原 SDK、独立插件包及冻结/用户 App 仍按原摘要和文件清单核验。类型、边界、合同生成检查、仓库格式及新增 TS/相关 Core 和客户端格式检查通过。写入空间不足时只清理已核验空闲的本任务依赖缓存和正常停止的原测试 Pg 数据目录；原源码、dist、锁文件、SDK tar、服务日志和所有 App/插件包保留。
