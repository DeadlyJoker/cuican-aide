# 已安装插件的完整 Web App 验收

此专项从正式 `apps/crewon-ui/dist/index.html` 启动，经过原 `main.tsx`、`AgentPlatformAuthGate` 和 `App`。页面通过原登录表单取得具名测试账号，使用实际 BFF 会话和生产模式 Control，再经正式 Worker 与 PostgreSQL 执行独立报告插件。没有替换正式入口、注入 Control 客户端、安装 Native preload 或改写原页面样式。

## 运行

使用仓库指定的 Node.js 24、pnpm 10，并提供独立测试 PostgreSQL 数据库：

```bash
CREWON_TEST_POSTGRES_URL='<isolated test PostgreSQL URL>' \
  pnpm --filter @crewon/control-api test:installed-plugin-full-app
```

该命令先构建正式 UI，再通过唯一共享 producer 打包 SDK、在仓外构建报告插件的两个版本。实际删除开发源码、依赖和 SDK 临时目录后，消费者只读取完成的插件包。消费者物理结束后才删除本次临时产物；该命令不启动或停止用户的 PostgreSQL、预览服务，也不操作生产安装目录。不要与其他修改 SDK 构建产物的 producer 同时运行。

可设置 `CREWON_FULL_APP_EVIDENCE_DIRECTORY` 保存截图和证明，默认目录为 `output/extensions/checks/installed-plugin-full-app-browser`。证明不记录账号密码、token、cookie 或完整请求头。数据库每次使用独占 schema，正常结束与失败收尾均检查子进程终止、schema 删除、连接、端口和临时目录清理；中断验收时应同时检查独立测试数据库的剩余资源。

## 被验收的路径

- 原用户栏打开原设置导航；“工具与扩展 → 已安装插件 → 业务配置”读取真实安装身份和 PostgreSQL 配置。最终正式 CSS、设置 lazy CSS 与通用任务控件样式实际加载。
- 打开独立模块时 Thread、Run、个人预留、模型和供应商调用均为零。点击通用“创建任务”后只有一个 Thread，仍没有 Run。
- 真实报告包的页面提交一次业务动作，经原安装模块动作端口创建一个 Run。完整包身份、principal、actor、profile、配置修订和个人预留与持久事实一致。
- 点击“打开任务”进入原任务页；实际 Run/Thread SSE 返回成功，原转录显示 Worker 的报告结果。线程空闲事件流等待原心跳，不将尚未返回的响应头当作成功。
- 物理重启 Control、Worker，并使用独立的新浏览器目录重新登录；原侧栏打开同一任务，原转录和模块读回已完成状态。没有第二次创建、预留或供应商提交。

安装、选择、首配、唯一 CLI 发布和 activation 是明确的操作者前提；本专项不声称已经覆盖用户从空库完成安装和自动发布。报告包使用原 ToolExecutionReceipt，但没有使用 SDK ExternalOperationStore，因此此用例外部 operation 数量为零，不能据此宣称 Krea2 查询能力已被完整 App 验收。

## 具名服务与证据限制

登录/当前身份、profile、策略、模型 Responses、专业报告供应商以及个人钱包/报价均为明确的测试服务。配置使用真实 HTTP，发布、激活、任务、预留、事件和转录均走实际产品实现与数据库；测试价格和资金不是生产价格或赠款。预留没有执行真实结算。

Chromium 用隔离的 Electron BrowserWindow 加载 HTTPS Web 页面，禁用 Node integration、保持 context isolation，没有 Native 桥。这不证明正式 Electron Main/preload、file App 或 packaged App 的插件执行。

SSE 响应和最终转录证明实际事件流可打开及结果恢复，不单独证明实时 delta 逐帧驱动 DOM，也不替代原任务运行时的 `Last-Event-ID`、断线重连与退出竞态覆盖。用户 ComfyUI 地址、第二个实际企业 API、真实个人资金来源/价格/结算和完整短剧持久项目仍需分别验收。
