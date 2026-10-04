# Native 原报告与独立财务 HTTPS 验收

本专项沿原 Worker Main 和真实 `CrewON.app` 验证[独立结算部署](./installed-plugin-credit-worker.md)，不新增产品运行时或界面。身份、PDP、供应商、模型、入账 100、报价 30 和结算 18 均为具名测试输入，不代表生产个人钱包或收费规则。

## 原 Worker Main

实际 Node.js 24 进程加载原 Main、发布版本和 stdio MCP。财务服务使用原测试 CA、真实 HTTPS server 和原 fetch；配置为独立 0600 文件及两个明确 token refs，没有 DNS、TLS 或传输替换。

- 无 opt-in 和四类无效配置、tenant mismatch 保留原六项行为。
- MCP 真正启动后，HTTPS 明确 deny。MCP 的原 close 暂停期间 Main 不退出；释放后核对实际子进程已消失，财务表保持。
- 原 Store API 准备有界 v1 付费终态事实，原 Main 索引扫描取得真实 ready 证据。HTTPS 先 hold、后明确 settle 18，原 Store 原子提交一项决定及账本流水，钱包为 82/0/18，原 Run 事件保持。
- 新 Main 重新打开同一数据库，等待原 Service 读取 existing finalization 后的第 4 次授权响应完成；不再次请求金额或扣费。
- 明确 deny 永久撤回同 owner；恢复服务 allow 也不能重新打开财务请求。另一项在真实决定响应体仍挂起时 SIGTERM，核对原 fetch abort、响应连接及 MCP 物理退出，原预占保持，未提交结算。

该 Main 夹具的业务终态由原 Store API 准备，不证明实际供应商执行。初始化阶段尚未安装 Main 的 shutdown handler，不能用该阶段 OS 退出声称财务请求优雅 join。

## 真正打包桌面流程

原 builder 编译自有 Host/runtime，并逐字节复制正式 Renderer 到真正 `.app`；原 manifest/main、fuses、preload、窗口和网络保护保持。外部 inspector 只在核对自然 packaged 身份之后加载未改的原 report observer。

原账号菜单 → 十类 Settings → 原 professional 1.0.0 模块 → 创建 Thread → 原 UI 提交报告。具名 PDP 只绑定 UI 实际产生的一次请求；原 Control/Worker 加载安装 Node 字节，经原 Agent/Tool 和报告包 HTTP adapter 执行。没有预建 Run、admission、成功工具回执、供应商结果或财务决定。

独立 HTTPS 的唯一 `/decide` 请求必须携带原 v1 full pin、ready=true、completed Run/Tool/work items 和非 running attempts。持久决定逐字段等于该真实响应，包括 decisionId；历史 evidenceDigest 保持。实际账户与三笔 grant/reserve/settle 流水核对 100/30/18，余额 82、预占 0、spent 18。

暖 Main 及其原 runtime 子进程全部物理退出后，新 Main 从原任务页面读回 Thread 文本与模块 completed 状态。冷 owner 使用 `migrate:true`，第 6 次授权响应证明原 Service 已读取 existing finalization。所有供应商 GET/POST/DELETE、模型执行、报价、原业务表、回执和不可变决定保持；目录探测和财务授权可重新发生，不能声称所有 HTTP 为零。settled 后当前 Store evidence 的 ready=false、摘要变化是预期，不能与历史决定输入混淆。

观察器沿原 `app.quit` 退出，没有等待后人工补写结算。清退另失败时保留原始错误；无法核验消费者退出时保留私有目录。原 Supervisor 超时 SIGKILL 仅证明物理退场，不扩大为所有在途财务 HTTP 的优雅 join。

## 复现与边界

Worker 窄专项无需供应商配置：

```sh
node --experimental-strip-types --test apps/runtime-worker/src/plugin-credit-settlement-worker-process.integration.test.ts
```

打包专项需要原保留 professional 和 Krea 包，设置 `CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR`、`CREWON_TEST_KREA_PLUGIN_DIR` 的绝对目录；`CREWON_PACKAGED_CREDIT_APP_EVIDENCE_DIRECTORY` 指定外部证据目录，然后执行：

```sh
pnpm --filter @crewon/ui exec vitest run electron/desktopInstalledPluginRuntime.packaged-credit.integration.test.ts --reporter=verbose --maxWorkers=1 --no-file-parallelism
```

当前结果、首次失败、实际退出码、截图及保留摘要以 `output/extensions/checks/native-financial-http-proof-20261004.json` 为准。打包冷回执核验是原页面历史读取和 Store 原回执读取，不扩为 report v1 表单 durable recovery、实时 delta 或执行中断线重连。

本阶段不改变用户栏、Settings、侧栏、全局 CSS、SDK 或发布插件包。真实个人身份/入账/定价/失败规则和财务服务、Native Krea2 公网生成/原 operation 查询、同次完整 App 在线 S0、所有插件打包链路和用户选定实际企业 API 的 E5 仍需验收。
