# F05 证据

工作分支 `codex/f05-browser-execution`，共享基线 `79bf09d88`。所有写入在本工作树；原目录和其他 feature 工作树只读。状态：生产接线和合成模型垂直验收完成；实际录制来源的真实模型 Skill 联验仍进行中。

## 产品接线

Electron `main.ts` 保留唯一 F02 `RecordingHost`，在 Runtime 启动前安装 `startDesktopBrowserExecution`。主窗口认证 IPC 只提供 authorize/revoke/status；浏览器凭据仅注入 release/Worker 子进程。Runtime 停止、窗口关闭撤销授权。

桌面 release 写 `toolRuntimeMode: shared`，实际 Worker 先组成浏览器 runtime 与 F01 同一 DeliveryApplicationService，再绑定至冻结 AgentVersion；每个版本按自己的工具目录筛选。云 Agent/independent binding 不继承本地浏览器权限。Control 每次检查真实 Run/thread/workspace、运行状态及 F03 `ensureRunSkillAllowed`；F04 日程参数从冻结的 occurrence Run 绑定解析。

执行复用公开 `puppeteer-core@25.9.0`、`ExtensionTransport.connectTab`、ElementHandle/Locator；名称与角色复用 F02 的 `dom-accessibility-api@0.7.1`。模型没有 JavaScript、CSS、CDP 或宿主路径入口。观察最多 9 KiB；一次下载最多 10 MiB。持久请求日志在动作前 fsync，未知效果不重放。下载返回前等待真正 completed 字节、点击结束和焦点仿真 finally 恢复。

## 已完成的真实桌面垂直验收

脚本 `apps/crewon-ui/scripts/browser-execution/desktop-run-acceptance.ts` 启动真正 RuntimeSupervisor release、Control API 和 Worker 子进程，使用真正 F02 RecordingHost/WebContentsView、生产授权 HTTP 桥、Puppeteer 和 F01 importer。模型是明确脚本化 Responses SSE，订单页面是合成本地 HTTP；没有替换 Control 权威或文件入口。

证据 `artifacts/f05-browser-execution/desktop-run.json`、`desktop-run.png`：

- Run `01a09e31-4330-73eb-a298-e769ec1814c8` completed；10 次模型请求，依次观察、填写日期、选择渠道、筛选、下载和调用 delivery_catalog。
- 页面结果 `2026-09 / partner`，实际 CSV 下载请求 1 次，39 字节。
- F01 input `e03c7bde-d222-406c-ae16-e126bf2313c0`，sourceRunId 与真实 Run 相同。
- 摘要 `sha256:8bad3bb086e9ce930f0edf6ffcbc332600edbbe8c674509c8762d34710eaa29a`，通过认证 F01 内容接口读回并逐字节比较。
- Runtime 重启后同一 inputId/内容可读，浏览器授权为空。没有把脚本模型登记为真实模型 Skill 试跑。

```bash
pnpm --filter @crewon/ui desktop:host:build
pnpm --filter @crewon/ui exec esbuild scripts/browser-execution/desktop-run-acceptance.ts --bundle --platform=node --format=esm --target=node24 --external:electron --external:puppeteer-core --outfile=dist-electron/browser-execution-desktop-run.mjs
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/crewon-ui/dist-electron/browser-execution-desktop-run.mjs
```

另有 `scripts/browser-execution/acceptance.ts` 的同视图真实 Electron 驱动检查：原生 input/change、页面代际、等待取消、真实下载、debugger detach 后重新附着、人工输入事件与自动化事件区分。`artifacts/f05-browser-lifecycle/same-view.json` 补充 readonly、disabled fieldset、不存在的 option 均在效果前拒绝，以及下载返回时焦点已经恢复。该脚本单独不包含 F02/Run/F01，不能取代上述垂直验收。输入为自动化驱动，未声称人工桌面接管。

## 故障、边界与兼容性检查

- `browser-delivery-run.test.ts` 使用真实 RuntimeWorker、SQLite RunStore、认证 HTTP transport、持久 BrowserExecutionReceipts、withDeliveryToolRuntime/F01 importer 和加密 SqliteDeliveryStore；模型与远端浏览器明确为夹具。精确 10 MiB CSV 导入后、Worker 提交前制造故障；重开 Worker/RunStore/vault/host 日志，序列 execute/download/reconcile/download，点击 1 次、持久 putInput 1 次，inputId/SHA/sourceRunId 保持一致，后续同 Run catalog 可读。39 项相关检查通过。
- 持久回执 30 项检查含真实子进程 SIGKILL；授权/宿主 37 项检查含 Run 身份、Skill 版本/日程参数、撤权、取消、并发冲突和旧观察拒绝。驱动生命周期修订后 51 项窄检查通过。
- 最新合并协议测试 118/118；Control authority/F01真实HTTP/Skill宿主/日程事务/生成路由 15/15；单服务 delivery target seam 增补后相关 Control 25/25。
- 主窗口相关 authority/transport/F02/RuntimeSupervisor 37/37。日期控件无 ARIA role 时保留空 role 并精确匹配名称；不伪造 textbox。相关 grant 17/17。
- Control、Worker、Electron 宿主 typecheck、宿主 build、boundary、pnpm format 已分别通过。仍需在最终证据提交时重跑变更后的必要组合检查。

## 实际来源与待验收

`artifacts/f05-browser-execution/recorded-source/` 原样复制 F02 实际隔离 preload→IPC→Store→回看修改→C01 导出的样本和 13 个 evidence，保留 `sha256:4e3b4cb1fdb476fe52281cb85feae9d2caf933f08f0441e93bf04f2c136b7a15`。这是合成业务页面的实际录制，非手写 C01；输入由自动化和焦点仿真产生。

真实 gpt-5.5 方法生成、代理审阅、第二周期实际文件和 Skill 试跑正在单独验证；结果只有实际通过后才更新。企业登录、人工/CUA、跨源框架、canvas、shadow 控件及现场日程 occurrence 未据此宣称完成。F01 XLSX 计算/模板材料有独立 owner 证据，浏览器探针的 39 字节 CSV 不构成第二周期 200.00 汇总验收。
