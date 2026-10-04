# Native 安装插件任务的 Electron 源码启动接线

日期：2026-10-04。本阶段把独立任务配置接入原 `RuntimeSupervisor`，沿原自动准备、release、Worker 私有 challenge 和 Standalone Main 启动流程签发任务 publication。范围是 **Electron 源码 Supervisor 与真实子进程入口**，不等于编译后的 Electron、窗口、preload 或完整 App 已通过任务验收。

原 Main 的文件 opt-in 和读取边界见[Main 启动与独立读取](./native-installed-plugin-task-main.md)；执行 owner、个人积分事务与权限分工见[任务执行接线](./native-installed-plugin-task-execution.md)。这些文档记录各自阶段，本篇补充 Supervisor 接线与普通任务冷重放兼容。

## v4 配置与兼容

数据目录中的 `desktop-installed-plugin-runtime.json` 新增 `crewon.desktop-installed-plugin-runtime.v4`。启用形状沿用 v3 的 `providerBinding`、`plugins`、`workerAuthorities` 和 `activationAuthority`，另要求完整 `taskExecution`。不从默认值补造 profile、账号、资金、价格或权限 epoch。

`taskExecution` 严格包含七项设置：

| 设置                  | 作用与限制                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `uiPublications`      | 1–32 个精确 pluginId/packageDigest/contributionId，禁止重复；须匹配实际 bootstrap source 与 publication |
| `taskPolicyAuthority` | 任务资源 PDP 的明确 HTTPS endpoint 和凭据环境变量引用                                                   |
| `uiPolicyAuthority`   | 安装 UI 的独立 HTTPS PDP 和凭据引用                                                                     |
| `packageAuthority`    | 实际执行包批准的 HTTPS endpoint 和凭据引用                                                              |
| `quoteAuthority`      | 个人插件积分报价的 HTTPS endpoint 和凭据引用                                                            |
| `timeoutMs`           | 1,000–30,000 毫秒整数                                                                                   |
| `maximumPackages`     | 1–32 个包                                                                                               |

外层配置最多 128 KiB；签发的 `crewon.desktop-installed-plugin-tasks.v1` 私有任务文件最多 64 KiB。解析拒绝未知字段、访问器、异常原型及不完整设置。endpoint 不接受明文 HTTP、URL 内凭据、query 或 fragment。

v1 的显式 Worker 配置、v2 的自动准备和 v3 的 activation 配置仍走原协议；它们不读取新的任务凭据引用，不签发任务文件，也不获得生成、报价或资金权限。各版本的 `enabled: false` 仍只接受原关闭形状。缺省启动继续使用原能力。

## 私有文件与进程边界

`captureDesktopInstalledPluginTaskRuntimePublication` 在启动子进程前，从真实文件配置、bootstrap owner 和数据字段环境捕获四类任务凭据。值冲突、缺失或访问器拒绝；秘密不写入配置 JSON、publication、日志或 inspect 输出。

完成原 Worker 的实际私有 challenge 和 activation publication 后，`createDesktopInstalledPluginTaskFiles` 才签发独立任务文件。文件绑定真实 actor/scope、installRoot、bootstrap authorityEpoch 和已严格解析 activation 的 canonical digest。UI-only source 不必冒充 Worker entry；生成目标的准入仍由接收任务配置的 Main 和原执行 owner 核验。

Main 得到 `CREWON_DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_PATH`、真实 companion paths 及明确任务凭据。release 与 Worker 不得到任务配置路径或独立任务凭据；若凭据引用同时属于原 Worker 显式批准的 authority，投影只保留其已经批准的同值角色，不因任务设置扩大 Worker 权限。本阶段具名夹具使用独立的 task/UI/package/quote token，观测要求它们只出现在 Main 子进程。

任务文件位于数据目录下独占的 `.installed-plugin-tasks-*` 目录：目录 `0700`、`tasks.json` 为 `0600`。签发 owner 持续检查原配置、bootstrap、activation 实例、文件与目录身份及权限；修改、替换或撤回后拒绝使用。Main 保留实际 FileIssued/current 核验，程序对象、浅复制或旧 companion 文件不能替代签发证明。

关闭先同步撤回准入，再沿原 Supervisor 所有权等待实际消费者物理结束，随后删除仍由本 owner 持有的任务文件并清理秘密引用。迟到读取拒绝；已经提交的任务只可通过原账本确认的 opaque 回执返回，不能据此再次准入任务。

## 普通任务与当前证据范围

新增源码进程专项使用实际 Supervisor、原 release CLI、Worker `main.ts`、Control `main.ts`、安装 Node/UI、ControlClient 和同一文件 SQLite。专业插件的普通任务经独立任务/UI/package/quote authority、原 Turn/Run 和个人积分事务提交；没有增加绕过 Run 的 ComfyUI 调用。

具名测试个人账户明确提供 100 积分，测试报价为 30 积分。这些是测试资金和价格，不是产品赠款、用户钱包或生产定价。实际夹具 Worker 保持 metadata-only 策略并拒绝 `run:execute`；专项在观察到拒绝后明确取消 Run。已提交的任务及个人预留事实，不代表付费供应商任务已完成，也不证明模型、生图、消费结算或退款结果。

新增三项真实源码进程专项 **3/3、零跳过**通过，覆盖以下边界：

- v4 只向 Main 签发任务文件和独立凭据；拒绝任务 PDP 时没有新业务副作用，允许后只提交原任务，读取继续检查 `extension:query` 与 `run:read`。
- 正常物理关闭并重新启动后，session、CSRF、mount、bootstrap epoch 和任务 publication 重新签发；旧 session/mount 拒绝，新 mount 仍须当前 PDP 允许才能显式重放原请求。
- 任务目录变化和 authority token 撤回拒绝新任务，原 metadata 继续可用；v3 metadata 启动没有任务文件、独立任务凭据、报价或任务准入。

实际测试入口为 `apps/crewon-ui/electron/desktopInstalledPluginRuntime.tasks.process.integration.test.ts`。SQLite 与自持 PostgreSQL 18 的存量回执、准入及真实 Application 组合 **45/45、零跳过**通过；普通任务 Application **44/44**、原项目生成/查询 **59/59**通过。自有 PostgreSQL 在测试消费者结束后确认其他 backend 为零，正常停止、核验实际 PID 退出，再删除该夹具目录。各组范围重叠，不相加。统一证据为 `output/extensions/checks/native-task-electron-proof-20261004.json`。

## authorityEpoch 轮换后的原回执兼容

冷重启会签发新的 authorityEpoch。原普通任务的 v1 request digest 包含完整 pin；直接用新 epoch 重算同一幂等键会与已提交回执冲突。修复保留原 v1 摘要和不可变审计事实，增加可选的 `ExtensionStore.loadPluginTaskAdmissionByReceipt`，不改原 receipt、价格、store pin 或存储 schema。

SQLite 和 PostgreSQL 按原 task receipt 主键做精确单回执查询，再严格核验关联的原 admission。调用输入捕获 tenant、space、profile、plugin、principal、actor 和原幂等键；没有扫描候选 Run、选取最近记录或放宽租户作用域。

`resolvePluginTaskReceipt` 仅在核验已存在的原回执时恢复旧 authorityEpoch，重建原完整 v1 fingerprint。其余身份、profile、选择修订、包/source 身份、贡献与动作、thread、业务 input、原 CAS、key 和 binding 关联仍须精确一致。当前调用继续使用新 pin 接受当前 PDP、实际请求 owner 与选择检查；保存的旧 epoch 不是新的权限，也不能绕过撤权。

没有原回执时仍使用当前完整 pin。不同 epoch 的并发首次提交仍严格冲突，不能把兼容读取变成第二次准入。成功重放返回原 Run、消息、配置修订和原价格，不重新报价或预留，也不把旧回执写成新 epoch。缺少该可选端口的旧 adapter 保持原 full-pin 路径；原 query 与项目动作/恢复协议不变。

## 保持范围与剩余工作

本阶段不改原 App、用户栏、设置、侧栏或共享样式；UI 14 个保护源文件、15 份正式资产、SDK 60 个保护文件与冻结 tarball、生产 9.0.0 项目映射及既有 8.0.0/9.0.0/10.0.0 发行包保持原范围。最终摘要与检查证据由主任务复核，本篇不是新的重建或发行证明。

任务文件已删除、但其后的目录身份检查或删除失败时，owner 保留撤回和清理错误，阻止重新启动；本阶段不宣称这一部分清理失败可自动重试成功，也不删除无法确认仍归本 owner 所有的目录。

尚未完成 compiled/packaged Electron、正式窗口/preload/full App 的短剧生成/查询/选用三通道联合恢复，也未完成付费 ComfyUI S0、用户真实个人钱包/资金/定价/结算或第二个实际企业 API 的 E5 验收。专业插件普通任务的源码启动接线与原键重放，不能替代这些目标。
