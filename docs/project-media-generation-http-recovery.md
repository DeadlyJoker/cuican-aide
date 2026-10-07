# 对话侧媒体请求恢复

2026-10-07。接续[共享媒体生成命令](./shared-project-media-commands.md)。本次完成 HTTP 与插件页面共用持久生成意图，为原 Agent 对话中的执行入口提供恢复能力。没有新增可见对话控件或模型工具，不能将本次接口验收当作 Agent 自动执行已经完成。

## 协议

显式启用 `projectMediaGenerations` 的宿主同时注册原 POST 和新的只读接口：

```text
GET /api/v1/creative-projects/:projectId/threads/:threadId/media-generation-recovery
```

请求只接受路径中的项目、原会话；query 必须为空。原请求身份、profile、当前项目会话绑定、工作空间、已安装包和发布权限均重新校验。响应最多 4 KiB，格式为原媒体恢复协议的 `{ intent: null | hint }`，不返回供应商地址、工作流图、材料凭据或服务端权限。读取不上传、不创建 Run，也不唤醒 outbox。

`ControlApiClient.projectMediaGenerations.getRecovery({ projectId, threadId })` 使用原认证传输，禁止自动重试和重定向。GET 不要求 CSRF；生成 POST 仍要求 CSRF、原幂等键与完整请求。

意图属于当前账户下短剧插件的 `workbench` 贡献点，优先返回该贡献点未决的媒体请求，否则返回最近一条媒体记录。它可能来自这个账户的另一个项目或会话。调用方必须核对 `intent.request.input.projectId/threadId`；不能将其他项目的回执显示为当前项目结果，也不能把其中的原会话替换为当前会话。

## 共用任务记录

HTTP 在素材准备前用实际 Core 的安装、身份和项目会话资格保存完整命令，再标记派发。使用父 Store 原有的意图 journal、数据库生成的 realm 和原请求摘要。服务端将逻辑 action 标记为 `crewon.project-media-generations.v1.generate`；原 TaskCore 仍使用 `media.generate`。没有构造 UI 挂载凭据或创建第二套任务执行器。

Short27 声明了 UI recovery，继续由原 UI recovery wrapper 保存和派发，HTTP 不对它重复计数。两个入口的请求相同时命中同一记录和原 Run。输入版本、执行 ID、幂等键或会话修订改变不能用来恢复旧请求。没有声明 recovery 的旧 UI 仍按原协议调用，不在本次完整双入口持久恢复验收范围内。

HTTP 受理成功后，只用原 TaskCore 的实际回执确认 journal。晚到的断线或撤销不会抹去已知受理。若这个次级确认失败，保留实际回执并记录诊断；journal 仍可能显示未决，明确重试原命令会从原 TaskCore 恢复，不重新读取或上传参考素材。

停止等待、服务关闭、恢复读取都不会自行重投。未知请求持续占用原生成类别，直到原结果得到确认；新键返回 `409 project_media_generation_recovery_required`。本次不增加删除、取消未决记录或跳过确认的接口。`retryable` 表示原安装范围匹配，不是生成许可，重试仍经过独立 `projectMedia:generate` 校验。

目前派发后的准备失败也保留原命令。若旧输入已无法满足条件，不能直接换新键跳过；对话控件开放前还需完成“明确未受理”的拒绝与解除占用流程，不能把它和响应丢失混为一类。该限制与既有页面恢复约束一致，本次没有宣称整套生成交互已经可交付。

## 兼容与边界

启用该生成运行时会准备父数据库原有 journal；未启用的宿主不注册新接口。SQL schema、原 POST 请求及成功响应、冻结 SDK 和已发布 Short27 完整包均不变。持久媒体 action 已由 Short27 宿主引入；不认识此 action 的更旧宿主仍不能读取新媒体意图，不能靠降级清除未决状态。

事务内使用实际安装快照和只含身份、权限、生命周期检查的回调；原 Store 在同一连接核对安装记录，不在单连接 PostgreSQL 事务中再次借连接。新的恢复入口不授予媒体输入读写或生成权限。

UI 沿用[插件主题范围](./plugin-variability-boundary.md#ui-主题接入约定)。本次没有修改 Renderer、插件样式、全局主题、宿主侧栏、账户或设置，也没有替换用户 App。后续对话控件仍需按原界面组件接入，并完成原 Run 流式接管和重连验证。

## 验证范围

证据保存在 `output/extensions/checks/media-http-recovery-20261007/`。测试使用真实 SQLite/PostgreSQL、父 Store、已安装包、项目绑定、HTTP、素材归档和原 TaskCore；模型、供应商及策略边界为具名测试数据，不代表真实外部生图。

覆盖 HTTP/页面互相读取同一记录、同请求并发只受理一个 Run、T10/D18 中断后新运行时恢复、旧键重试且不重复素材 I/O、权限撤销、外来项目/会话/profile、无效身份、额外参数和响应体边界。Native 检查另外覆盖关闭重开父数据库后的 HTTP 恢复及完整 Short27 的页面接力。

最终双库及相关协议检查 78/78、Native 检查 13/13、Control Client 全量 224/224 通过，均无跳过。Control、Contracts、Control Client 类型检查、边界和格式检查通过；7 个桌面运行时组件已构建并核对源码摘要。历史完整包、冻结 SDK、已验收 App 与用户 App 的原始字节保持一致。
