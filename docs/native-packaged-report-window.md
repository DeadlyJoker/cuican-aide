# 真正打包应用的 Native 报告插件验收

日期：2026-10-04。状态：真实 `.app` 报告专项首次 **1/1、零跳过、退出码 0**，最终组合中再次通过；原 Source 和编译窗口回归完成。完整插件目标继续 ACTIVE。本阶段承接[编译后原窗口](./native-compiled-report-window.md)，核对真实 macOS arm64 打包布局和原发布入口。

## 原入口和资源

新增代码仅为测试和 test-support。原 `electron-builder` 的 `dir` 目标组装独占目录中的 `CrewON.app`；原 UI manifest 逐字节作为输入，`main` 保持 `dist-electron/main.mjs`，没有 wrapper Main 或 `extraMetadata`。原 builder 正常清理输出 manifest 的开发字段，运行字段另作精确核验。未运行会重建前端的 `desktop:pack`，没有 SDK、Renderer 或既有插件包重建。

原 Main、preload、log writer 使用既有编译参数。原 `runtimeBundleSpecs` / `bundleRuntime` 编译七个运行入口和 scoped identity；真实额外资源沿原 manifest 的唯一 `desktop-resources/runtime` 配置拷入 `Contents/Resources/runtime`，没有开发 `.ts` alias。正式 Renderer 的十五个文件逐字节复制，另从真实 `app.asar` 读取并比对；Main、preload、source map 和全部 runtime 文件也核对摘要。冷退出后复核整个 ASAR 和 runtime 字节。原 Electron 43.4.1 本地发行目录供 builder 读取，禁用依赖重建，不下载或发布；原 fuses 只读核对，没有修改。

真实启动 `Contents/MacOS/CrewON --user-data-dir=<owned root> --inspect=127.0.0.1:<owned port>`。原版本在 JS 初始化前设置该目录，设置页、数据库和单实例锁使用同一私有目录；外部 inspector 读取实际 PID、可执行文件、Resources、`app.asar`、原 manifest main、Node24 和真实 `isPackaged:true`，同时拒绝 defaultApp 和 `ELECTRON_FORCE_IS_PACKAGED`。没有 `app.setPath`、伪造 packaged 值、入口重写、窗口/preload 替换或 spawn 接管。[Electron 43.4.1 原启动源码](https://github.com/electron/electron/blob/v43.4.1/shell/app/electron_main_delegate.cc#L229-L238)、[官方 Main 调试入口](https://www.electronjs.org/docs/latest/tutorial/debugging-main-process)。

inspector 等原 `app.whenReady()` 后核对实际字段，再用 Node24 `getBuiltinModule` / `createRequire` 同步加载私有 CJS 观察器，随即断开 debugger。观察器只操作原 Main 已创建的窗口，不能导入或启动 Main；其 fetch 检查点继续透明转交原请求、headers、signal、传输和响应。[Node24 内置模块接口](https://nodejs.org/docs/latest-v24.x/api/process.html#processgetbuiltinmoduleid)。

## 原页面和实际执行

验收沿原用户栏→设置→返回→专业报告模块→原创建任务→原刷新上下文→原业务表单提交→原任务结果→原模块 completed。实际 Native UI 默认语言由隔离目录和系统决定，脚本适配原中英文标签，不写语言偏好、不替换样式或控件。报告 v1 自身中文表单字节保持。

原页面只提交一次真实 `report.generate` 命令。父测试核对实际 Thread 和旧 CAS、subject、无准入副作用后，才把原 UI key 一次性绑定具名 PDP。原 FileIssued v4、Worker challenge、当前 profile、完整 pin、保存的 paid receipt/admission、独立 deployment 和 Agent/Tool Broker 保护继续核验。完整打包资源存在工作区 MCP，因此原默认 Agent 指纹可不同；独立 report target 使用原裁剪 recipe，不删除旧 Agent 或重写 deployment。

实际 Worker 使用原安装 professional 1.0.0 Node/HTTP adapter，具名 HTTPS 模型两次请求、供应商一次 POST、报价一次；原 SQLite 保存 completed Run、报告 assistant 文本及同一次供应商 executionId 的 completed 工具回执，ComfyUI operation 数量为 0。初始 100 和每次 30 为明确具名资金/价格边界；余额 70、预留 30、spent 0，不作为真实收费或结算。

原 Main 正常 quit，由原 Supervisor 物理加入 runtime children，再以新实际 Main PID 冷启动同一隔离目录。撤回 Worker 执行许可后，原侧栏读回相同 Thread 文本，原模块刷新同一 completed Run；数据库事实、钱包、模型、供应商与报价次数保持。冷阶段回执仅定位原任务，没有重新提交业务表单，不声称 report v1 表单回执 durable recovery。两次原模型目录子进程分别产生实际探测增量，原 Main 的 Thread SSE 均返回 200/event-stream；不扩为执行中 delta、断线或自动重连验收。

packaged Main 会过滤启动 `NODE_OPTIONS`；本阶段不回注 `--import`，不沿用开发版 Node import 观察器的证据。另通过实际 OS 父子树与精确可执行文件/Resources entry argv 记录原 Control、Worker、目录和 release 子进程，结合原工具回执和供应商请求证明业务执行。所有自有进程和流须物理结束，任何观察器失败都继续独立清理；只有确认 children 退休后才允许删除 owned root。[原版本 Node options 过滤](https://github.com/electron/electron/blob/v43.4.1/shell/common/node_bindings.cc#L414-L462)。

## 证据与剩余工作

专项入口为 `apps/crewon-ui/electron/desktopInstalledPluginRuntime.packaged-report.integration.test.ts`。首次通过证据在 `output/extensions/checks/native-packaged-report-app-locale-repair-20261004/`。最终打包证据在 `output/extensions/checks/native-packaged-report-app-final-20261004/`，包含十一张实际页面截图和 `native-packaged-report-app-proof.json`。

最终八文件组合实际 **34 通过、1 跳过、0 失败、退出码 0**；被跳过的是缺少 `CREWON_TEST_SHORT_DRAMA_RECOVERY_DIRECTORY` 的原项目恢复专项，未计作通过。随后补齐该环境单独执行原专项，实际 **1/1、零跳过、退出码 0**。两组共同覆盖所选三十五项行为，不称组合零跳过，不相加其他历史检查。日志分别为 `native-packaged-report-source-final-20261004.log` 和 `native-packaged-report-projects-fill-final-20261004.log`。Host 类型、boundary、格式和保留检查及实际终止结果归档在 `output/extensions/checks/native-packaged-report-proof-20261004.json`。

保留修复前真实失败日志：测试配置重复拷贝 extraResources、外部 inspector 动态 import probe 失败、初始化字段严格断言，以及脚本写死中文标签。修复限于新验收装配；产品 API、身份/租户保护、Agent 冲突、原网络、DNS、TLS 和资金许可未放宽。

本轮以 `c499da519b8c12b74120b9f588feef133ee23063` 为保留基线，不能声称全部前端等于最初 `776484c57`。原账号/Settings、侧栏、全局样式、正式资产、SDK/冻结包、三个旧独立发行包、生产映射与用户服务继续核对；不修改 primary 的人类工作。

这是真实 `.app` 的具名报告验收，不是签名、公证、安装发行或所有插件的打包完成。Native Krea2 实际公网生成/原 operation 查询、可用 ComfyUI 的同次原完整 App 保存→生成→显式查询→图片选用→重启恢复 S0、真实个人身份/资金/价格/结算和用户选定实际企业 API 的 E5 仍未完成。报告测试供应商不满足 E5，`createThread` 仍不属于三类 durable recovery。本阶段没有请求用户原 ComfyUI，也没有生产钱包拨款或价格配置。
