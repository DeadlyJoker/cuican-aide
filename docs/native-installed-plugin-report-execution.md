# Native 安装报告插件的实际 Worker 执行

日期：2026-10-04。状态：实际 Native Source 报告专项已通过，完整插件目标保持 ACTIVE。范围是原 Electron 源码 Supervisor 与实际 release、Worker、Main 子进程中的独立报告任务，不包含原完整 App、编译后 Electron 或打包版验收。

本阶段在[Native 私有任务签发](./native-installed-plugin-task-electron.md)及[项目跨 epoch 恢复](./native-project-execution-integration.md)之后，增加明确选择的实际 Worker 执行场景。原 metadata-only 夹具及其拒绝行为继续保留；没有增加产品执行开关、运行时或构建系统，也没有替换产品网络传输。

## 实际调用范围

使用已保留的仓外独立 `example.professional` 1.0.0 包，沿原安装、配置、启用、release CLI 和 FileIssued 私有任务文件启动。Control 从实际安装字节加载 `node.mjs` 的 `report.generate` action，经过原 `PluginTaskActionBridge` 和 Task Application，在同一 SQLite 事务中提交原 Turn/Run、不可变 binding、admission、报价与个人积分预留。Worker 再从实际安装包加载原 execution factory，通过原 Agent、Tool Broker 和工具回执路径执行。

模型是明确具名的本地 HTTPS Responses 服务。它在第一轮返回报告工具调用，第二轮必须取得 Worker 的实际工具输出后才返回 assistant 文本。供应商使用现有具名 HTTP 报告服务和持久 SQLite receipt；实际报告包继续使用自身原有 HTTP adapter。该包没有声明 Host JSON HTTP 服务，因此本场景明确保持 Worker `networkAuthority: null`，不把 Krea2 的网络批准借给报告任务，也不放宽 ComfyUI 的 HTTPS、DNS 或网络策略。

身份、profile、PDP、供应商、初始 100 个人积分和每次 30 积分报价都是具名测试边界。设置不预写 Run、admission、工具回执或供应商结果；100 积分测试资金通过原账本 grant 明确提供，不代表用户生产资金、默认赠款或真实定价。

## 独立的存量请求许可

测试增加可选 `installedReportExecution`，精确指定原幂等键、输入 subject 和报告服务地址。只有显式选择此场景，具名 Worker PDP 才核验同一 SQLite 中已经提交的原请求。默认 Native metadata 与项目恢复夹具继续拒绝 Worker 执行。

许可从原 task receipt 的精确作用域和主键取得 admission，并核对原 Turn、Run、完整 pin、命令摘要、binding、个人积分准入与预留、保存配置、实际安装选择、activation、已发布 Agent 和完整 deployment target。数据库及所属私有目录身份持续核对。保存的 receipt 不能单独替代当前 profile、选择和执行撤权；不同 Run、Thread、请求键或输入不能借用该许可。

读取历史与执行许可分开判断。冷重启后可撤回 Worker 执行，原受理回执仍只能通过当前 Main PDP、实际新 mount 和原精确请求核验后重放。执行撤权不是新的准入、供应商调用或积分结算。

## 专项验收内容

新增源码进程专项已验证以下同次流程：

- 第一项显式任务沿真实 Native HTTP/ControlClient 提交，原 Worker 调用模型与报告工具，供应商只收到一次 POST，实际 `ToolExecutionReceipt` 与 assistant 结果保存，Run 完成。Control 和 Worker 的实际 PID 都须观测到安装包 Node 导入。
- 第一项提交只报价一次，100 测试积分中的 30 保持预留，余额为 70，`spentCredits` 为 0。执行完成不代表结算。
- 第二项显式使用不同请求键与 Thread，完成独立任务准入和报价，但 Worker 执行拒绝；原客户端明确取消该 Run，没有新增模型或供应商请求。取消不被表述为已退款或供应商已取消。
- 原消费者物理停止后重新启动，session、bootstrap epoch 和 activation digest 重新签发。旧 session 与 mount 拒绝；当前 Main PDP 拒绝时原请求不能重放，重新允许后同一 key、input 和旧 Thread CAS 返回同一原回执。
- 冷重放保持原 Run、binding、admission、工具回执、消息及实际钱包记录，没有进一步供应商 POST、模型请求或报价；再次物理停止后任务私有目录清理完成。

该报告包使用原工具回执，不使用 ComfyUI external operation store；报告执行完成时该 Run 的 external operation 数量为 0。不能把报告工具结果当作 Krea2 的外部任务状态或图片结果。

SSE 检查在 Run 已完成后读取实际持久事件，核对 `tool.requested`、`tool.completed`、assistant delta 和 `run.completed`，再用 `afterSequence` 续读并在冷重启后核对原事件。它证明持久事件流和游标读取，不包含执行中断线、自动重连、DOM 或图片展示验收。

实际入口为 `apps/crewon-ui/electron/desktopInstalledPluginRuntime.report.process.integration.test.ts`。新增 Source 报告专项 **1/1、零跳过**通过；最终原 Source/activation/IO 与新增报告组合为 **6 个文件、33/33、零跳过**，包含该专项。原 Worker 旧/当前包执行及三类拒绝进程组合 **4/4、零跳过**通过。Host、Worker 类型检查、boundary 及保留检查通过。各组检查范围不同，不求和；真实终止结果与修复前部分失败日志保留。统一证据为 `output/extensions/checks/native-report-execution-proof-20261004.json`。

## 完整目标的剩余边界

本阶段没有请求用户原 ComfyUI、修改用户执行配置、安装选择、生产项目映射或收费策略。原前端、用户栏、Settings、两侧栏、正式资产、SDK 和既有独立插件包的保留检查通过；本篇不是前端重建、账户/设置页面实际可见性或发行证明。

还需 Native Krea2 Worker 的实际生成与原操作查询、可用 ComfyUI 的同次原完整 App 保存→生成→显式查询→图片选用→重启恢复 S0、真实个人钱包/资金/价格/结算、编译后 Electron 与打包完整链路，以及用户选定的第二个实际企业 API 的 E5 复用验收。报告的具名供应商执行与测试预留不能替代这些门槛。原 `createThread` 仍不属于生成、查询、选用三类 durable recovery。
