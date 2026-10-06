# 插件页面共享媒体输入协议

2026-10-06。状态：宿主接线及行为检查已实现；Short22 的[独立页面与分页目录](./project-media-input-page-protocol.md)已接入，Agent 输入工具和正式桌面联合验收继续实施。接续[原桌面批准](./desktop-project-media-input-approval-protocol.md)，遵循[八阶段双入口方案](./short-drama-orchestration-spec.md)。

## 独立入口和同一业务记录

新增 `crewon.project-media-inputs@1` 页面服务，初始动作是 `loadInput` 和 `saveInput`；Short22 在两者形状不变的基础上补充有界 `listInputs/getOptions`。使用[原逻辑输入协议](./project-media-input-protocol.md)及其 HTTP 形状：T10 固定一个已采用角色参考，D18 固定采用剧本、场景和两个有序且不同的角色。保存追加不可变输入修订；原键重放返回原回执。读取支持确切历史修订。保存不准备素材、不上传、不建立 Run、不发布候选或采用成果。

请求体最多16KiB，响应最多24KiB，提示词最多8192 UTF-8字节。拒绝供应商地址、任意工作流图、凭据及宿主身份字段；旧页面默认24KiB与文字专用60KiB传输限制保持。协议作为独立 Contracts 入口发布，不修改冻结 SDK。独立包的可移植客户端与编解码器由 Short22 固定摘要独立打包。

原 v3 Main 文件可选增加 `projects.mediaInputUi.publications`，明确批准原安装包及 `main.content` 模块。它与 `mediaInputs` 的读取/保存目的相互独立，二者都需要实际声明。来源 UI 必须是同一个已审查的 `crewon.short-drama` 包，确保事务中原目标安装行同时代表源安装。没有声明时原界面与服务可用性保持；旧 v1/v2 和历史项目形状不获得新字段。通用项目配置不接收新私有批准。

## 原调用者、事务和退出

页面服务借用实际 TaskCore 的共享媒体 owner、原 issued request 和同一个 SQLite/PostgreSQL parent。Application 只为已声明的页面动作登记真实活跃 invocation；复制 context、伪造挂载、错误包、过期 lease、未声明的服务或命名空间都在保存前拒绝。每次调用经真实 scope、selection、安装、profile、项目及独立媒体 PDP 检查。未知动作不会转发给任务执行端。

原 Application 的提交前事务 fence 单独捕获，通过每个 owner 的 AsyncLocalStorage 跟随实际调用。SQL 内仍复核同一短剧安装、项目修订和媒体写入授权；不会在持有原事务连接时再借一条连接查询安装。新增可选事务授权回调捕获实际函数，访问器与非函数拒绝；没有回调时沿旧行为在两个阶段执行原授权。

真正持久提交或原回执重放后，owner 签发仅一次可消费的内存身份结果。Application 核对原 invocation 与完整指纹后才确认保存。实际提交后的页面关闭或权限撤销不会把已提交的保存误报失败；JSON 中自报 committed 不能伪造此结果。读取没有持久提交资格，返回前仍检查活跃授权。

页面 owner 和 Core 退出均撤下服务可用性；关闭等待已借用的物理操作退场。提交前关闭、撤销或挂载变化回滚保存。父 Store 保持原生命周期。原生成、历史查询和其他服务的私有就绪标记沿 fallback 保持，不授予媒体执行或网络能力。

## 验证及交付界限

完整18份相关文件分五批检查，**163/163**通过；原 Main 定向两份文件**33/33**通过，均零失败、取消或跳过。覆盖真实 SQLite/PostgreSQL 保存、编辑、历史、HTTP/UI 共用回执、CAS、事务回滚、晚撤销后真实提交确认、owner/Core退场和可用性、错误挂载/协议与独立声明。五批自有 PostgreSQL 保持 fsync、full_page_writes、synchronous_commit 开启，正常停止并按目录身份清理。

业务元数据检查使用实际 Core、issued request、Application 页面调用及 SQL；UI 包校验、描述和 PDP 是具名夹具。Native 定向检查使用实际 Short21.0.1 安装字节、原 Main 身份和文件批准；独立声明存在时到达缺少真实挂载的拒绝，未伪造成功页面调用。Main 生产者与 Native 消费者仍是分别验收，不代表已渲染新插件页面、实际 Agent 输入工具或正式用户 App 联合验收。未发起供应商请求、素材传输或新生成。

初次 Pg 事务重复借池、夹具身份/信号、完整 UI 测试误触及低容量失败日志保留，不计通过。已修正真正的事务路径，原单连接池、容量门槛及 SQL 断言保持。一个包装类型检查误重建 SDK，已从冻结镜像恢复全部73个原文件并核对字节；后续使用直接 TypeScript 检查。原 SDK源/dist/tar、完整插件包、隔离 App 和用户 App 核验保持。

本节初始宿主接线证据在 `output/extensions/checks/project-media-input-ui-20261006/`。Short22已交付[可移植客户端与角色/场景/剧本表单](./project-media-input-page-protocol.md)；下一项是独立 Agent 元数据命令及原请求恢复，再接两个入口的素材准备、原 Run、候选与采用。结构化分镜、视频、声音、成片及有界跨阶段自动执行仍按各自契约推进，积分后置，完整目标 ACTIVE。
