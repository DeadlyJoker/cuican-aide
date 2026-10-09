# 结构化大纲到原分集剧本的连接

2026-10-09。此记录证明源码和隔离数据库的连接，不代表正式桌面已更新或完整短剧产品验收通过。

## 本次修复

旧剧本保存、采用和项目阶段入场只接受 v1 大纲。小说项目的 v2 大纲已经能读取和保存，却无法沿原 `episodeId` 继续写剧本。

现在通过显式 `ProjectOutlineSourceRevision` 接受两种大纲来源，保留真实大纲的 `artifactId / contentRevision / contentDigest`，不转换成伪造的 v1 文档。剧本仍使用原 v1 内容协议、逻辑产物槽、历史与回执表。旧大纲的公开读取、保存、采用和大小限制保持严格，不接受 v2 的隐式写入。

`ProjectTextStore` 新增可选只读方法 `loadOutlineSourceRevision`。SQLite/PostgreSQL 实现都从原记录读取并验证所有权、索引和摘要；旧 Store 没声明该方法时仍走严格 v1 读取。Application 固定方法和接收者，不调用配置 getter，也不借此获得新的写入权限。

保存剧本、采用剧本以及新建 script Stage 时，在原提交事务内比对 v2 大纲绑定的当前参数、原文与已确认方案。上游变化拒绝新工作；历史读取、已提交业务回执和原 Run 的同键恢复保留原来源。未知分集、外部所有者、把剧本当成大纲均拒绝。

没有 HTTP、插件 Node 协议、持久化 JSON 形状或数据库迁移变更。单一短剧 47 的冻结文件未修改，也未生成另一份插件包。宿主前端和主题未改。

## 验证

- 原文本、结构化大纲、手动 UI 提交、会话、计划 Store 和安装包回归：63 项通过、39 项 PostgreSQL 跳过。
- 新来源方法边界与实际 SQLite 脚本链：4 项通过、2 项 PostgreSQL 跳过。
- 实际短剧 47 发行字节、原 RuntimeResolver、原 script Stage、真实 SQLite Worker：1 项通过。明确使用无网络模型夹具，保存后模拟结果丢失，冷恢复同一业务回执，剧本只写一版、不自动采用，输出增量和 Run 完成；修改方案后拒绝新 Stage，原 Run 同键仍能恢复。
- Domain、Application、Store、Worker 类型检查和 TypeScript 架构边界通过。

日志位于 `/tmp/crewon-outline-script-regression.log`、`/tmp/crewon-outline-script-final-new-tests.log`、`/tmp/crewon-outline-script-final-types.log`。PostgreSQL 未配置，不能记为真实数据库通过。

## 桌面候选

干净验收工作树提交 `cf7f43de7` 已从源码提交 `a2aa98ee0` 同步本次实现。0.1.55 候选的深度严格签名核验通过；原 15 个 renderer 文件、4 个 CSS、preload、日志写入器和 `https://pim.aicuican.com` 账号地址保持。7 个运行时文件摘要逐一核验，Control/Worker 均包含新来源读取和提交检查。

候选位于桌面验收工作树 `output/extensions/desktop55-delivery/CrewON.app`，证明为同目录 `package-proof.json`。保留短剧 47 原冻结目录，不重建；0.1.54 候选也未覆盖。打包完成后只删除本次生成的 ASAR 解包中间目录。

## 尚未完成

正式 App 仍为 0.1.53、选中短剧 45、原管理员登录保持。0.1.55 与短剧 47 候选已准备，包含本次新增剧本连接。用户回复已解锁后，工具仍报告 Mac 锁屏，因此没有退出、替换 App、安装插件或发送外部模型保存请求。

本次只连接单次 script Stage 与原剧本服务。执行计划读取仍需逐项检查 v2 来源；剧本页面的依赖状态仍沿旧 brief/大纲采用版本比较，不宣称覆盖新的 Foundation 变更提示。专业剧本结构、角色场景、分镜视频音频、时间线与成片及完整创意/小说项目逐项验收仍按原清单继续。未知 Comfy 操作没有重提。
