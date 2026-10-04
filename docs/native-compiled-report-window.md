# 编译后 Native 原窗口的报告插件任务

日期：2026-10-04。状态：原编译后窗口专项通过，完整插件目标保持 ACTIVE。当前阶段承接[Native Source 报告执行](./native-installed-plugin-report-execution.md)，把同一独立报告包接到原 Main、preload、BrowserWindow 和完整 App 的真实页面按钮。

## 运行与保留边界

新增实现均为测试或 test-support。原 Main、preload、Control、Worker、release CLI 与模型目录子进程使用现有 esbuild 配置编译到独占临时目录；原正式 Renderer 逐字节复制，没有重建。实际 Main 自己创建窗口、会话、IPC、HTTP、安全请求门禁和 `crewon-plugin:` 资产协议，测试不创建或替换这些产品对象。

布局仍是原开发启动路径：`.ts` alias 指向旁边实际编译的 `.mjs`，身份文件由原 scoped build identity 产生。它证明编译后代码的原 Native 窗口路径，不是 packaged `.app`、签名、公证或安装发行验收。临时产物在物理进程结束后清理；证明保存编译产物和复制 Renderer 的摘要以及实际页面截图。

Source 准备仍使用原安装、配置、启用、release 和真实 SQLite，准备进程先全部物理结束。显式选择正式 `control-runtime-v1` 私有布局和空的 `0700` 工作区，使 Source 准备与 Main 使用同一工作区工具目录；默认 Source 夹具仍不绑定工作区。该对齐保留原 Agent ID 冲突检查，不删除或改写 Agent 记录。

本阶段没有修改 Renderer、账号菜单、Settings、左右侧栏或全局 CSS。保留检查以本阶段之前的 `be4cebd39d7bb470b08645b1fd3a76faa172226e` 为基线，不声称全部文件与最初 `776484c57` 字节相同，也不覆盖 primary 工作树的人类修改。原 SDK、冻结包、三个已有发行包、生产映射与用户服务保持。

## 实际页面提交

原未登录用户栏通过 Main 本机管理权限打开。测试从用户栏进入原设置页，核对十类设置和实际已安装报告包，然后返回原侧栏的“专业报告”模块。原 Native 资产协议读取原 `example.professional` 1.0.0 UI 字节，页面没有通过测试 importer 加载插件。

原“创建任务”按钮创建实际 Thread。通用“任务会话已就绪”早于独立 UI 的异步 props 更新，因此专项再点击原“刷新任务状态”，等真实读取和页面渲染后填写报告主题、点击原“创建报告任务”。没有直接调用业务 action、设置插件内部数据、重建实包或人工补写任务结果。

Main fetch 的有界观察器读取唯一真实出站命令，父测试核对真实 Thread、旧 CAS、subject 和无准入副作用后，给具名测试 PDP 一次性绑定原 UI 生成的 key。检查点不替换请求、响应、headers、signal、DNS、TLS 或传输，也不能单独授予 Worker 执行；原保存的 admission、paid receipt、完整 pin、配置、profile、选择与 deployment 仍须通过具名 PDP 核验。没有把许可或秘密放进 Renderer。

原 Control action、Task Application、Turn/Run、Agent、Worker Tool Broker 和报告包自身 HTTP adapter 完成同一任务。实际执行阶段的 Control 与 Worker 都必须观测到原安装 Node 文件导入。原页面显示受理回执，打开任务后显示实际供应商报告的 assistant 结果，再从模块读取 completed 状态。

该流程只有一次报价、两次具名 HTTPS Responses 请求、一次实际报告供应商 POST 和一个 completed 工具回执。100 初始个人积分与每次 30 报价是具名测试资金和价格；完成后可用 70、预留 30、spent 0，不能当作真实收费或结算。报告使用原 `ToolExecutionReceipt`，该 Run 的 ComfyUI external operation 为 0。

## 冷窗口读取范围

原 Main 正常退出并物理加入自己的 runtime 子进程后，启动新的实际 Main PID。当前 Worker 执行许可已撤回。原用户栏、设置与模块重新打开；原侧栏任务显示相同持久 Thread 文本，模块刷新显示同一 completed Run，数据库事实、钱包、报价、模型和供应商调用保持。

launcher 中的原回执仅作定位，冷页面没有重新观察报告 v1 表单回执，也没有再次调用 `report.generate`。这不是 report v1 表单的 durable recovery、原 action 重放或 `createThread` 恢复验收。冷 Control 的只读历史路径无需再次加载业务 Node action，不能把它算作第二次执行。

每次 Main 都须通过自己的原模型目录子进程实际 GET 模型目录，分别核对增量。真实 Main HTTP 的 Thread SSE 返回 200/event-stream，两次都观察到原流；文本也可从持久消息读取，因此不声称执行中实时 delta、断线或自动重连已经验收。

## 证据和未完成项

实际入口为 `apps/crewon-ui/electron/desktopInstalledPluginRuntime.compiled-report.integration.test.ts`。最终原 Source/activation/IO 与新增窗口组合 **7 个文件、34/34、零跳过**，包含新窗口专项 **1/1**，真实退出码为 0。Host 类型、boundary、格式和保留检查通过。专项保存的十一张页面和实际执行证明位于 `output/extensions/checks/native-compiled-report-app-final-20261004/`，统一检查证明为 `output/extensions/checks/native-compiled-report-proof-20261004.json`。分组不求和，修复前失败日志保留。

修正限于新验收装配：避免 Electron ESM 顶层等待 ready 的死锁；对齐 Source 与 Main 的工作区工具目录；在原 UI 异步更新后使用业务表单；执行 Node 导入断言仅属于真实执行阶段。没有改产品保护条件取得通过。

身份、profile、PDP、模型、供应商、初始资金与价格均为明确具名测试边界。账号和十类设置可见不等于生产登录或所有设置功能完成。报告 API 不是用户选定的第二个实际企业 API，不能计为 E5。

Native Krea2 仍要求原公网 HTTPS 网络许可，不能用本地 Comfy 夹具、假 DNS 或放宽 TLS 替代。可用 ComfyUI 的同次原完整 App 保存→生成→显式查询原 operation→图片选用→重启恢复 S0、真实个人身份/钱包/资金/价格/结算、packaged Electron 完整链路与 E5 仍未完成。原 `createThread` 继续位于三类 durable recovery 之外；完整目标继续 ACTIVE。
