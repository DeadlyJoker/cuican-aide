# F05 证据

工作分支 `codex/f05-browser-execution`，共享基线 `79bf09d88`。所有写入在本工作树；原目录和其他 feature 工作树只读。状态：生产接线、合成模型故障检查、实际录制来源的可复用 v5 真实模型 Skill→浏览器→XLSX 试跑 E04、同一 v5 的真实日程 E05 及重放检查均已完成。

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

## 实际来源与真实模型交付 E04

`artifacts/f05-browser-execution/recorded-source/` 原样复制 F02 实际隔离 preload→IPC→Store→回看修改→C01 导出的样本和 13 个 evidence，保留 `sha256:4e3b4cb1fdb476fe52281cb85feae9d2caf933f08f0441e93bf04f2c136b7a15`。这是合成业务页面的实际录制，非手写 C01；输入由自动化和焦点仿真产生。

`artifacts/f05-real-skill/result.json`、`model-history.json`、`real-trial.png`、`orders-second-period.csv` 和 `second-period-orders.xlsx` 保留真实 `gpt-5.5` 完整执行证据。原始实际录制→真实模型方法生成→明确代理审阅 v4→实际 F03 trial Run→相同 F02 WebContentsView→现有 C05/ToolRuntime→F01 下载输入→模型亲自调用 `delivery_assemble` 保存 XLSX→模型读取汇总/明细，全链实际通过。

- Run `01a09e50-6630-7286-bac0-ca27ff229539` completed；22 个真实模型调用均 completed，15 个浏览器/文件工具回执均 completed。生成 Run 的工具回执为 0。
- 页面日期 `2026-10-01`、渠道 `直营`；实际下载 CSV 167 字节，input `73853806-8eb8-435c-9a4f-78030daea188`，摘要 `sha256:f08a1997f69f54d2c2550015b0cb07f434da59c7b5eb91f53b657de0bd1a5a06`。
- 模型在同 Run 生成 XLSX version `89242b01-c3c1-45f3-8b7b-f41595dc50d0`，8533 字节，摘要 `sha256:08608f9f5c4558e59622deb8ed93ffe25114b73604f2c803def14389c6f3c161`。输入关联实际模板与下载 CSV，sourceRunId 与 Run 相同。
- F01 处理 5 行、明确排除 3 行、写入 A101/A103 两行；模型读取汇总得到 direct/CNY=200，独立 SheetJS 读取实际下载 XLSX 再核验 200.00。验收脚本没有代替模型调用 assemble。
- Runtime 真正重启后，同 CSV/XLSX 逐字节相同且授权已撤销。F03 trial 按新日期/新输入和实际最终文件完成代理审阅，保存在 result.json。
- 首次文件生成有一次明确、具体请求的正常审批，详见 `reviewed-approval-*.json`；这不是无人值守能力证据。企业登录、人工/CUA、跨源框架、canvas、shadow 控件及真实日程 occurrence 未据此宣称完成。

复用命令见 `scripts/browser-execution/real-skill-acceptance.ts`；凭据只从明确授权的 env 文件读入进程内存。首次运行会停在真实 generation 的代理审阅环节；复用运行读取已有 generation 和固定版本，不改写原始 C01。模板和 HTTP 页面是明确的合成业务材料，模型与浏览器/Runtime/文件链路均真实。

## 真实模型发现的协议问题

`artifacts/f05-real-skill/candidate.json` 保留真实 provider `gpt-5.5` 对上述 C01 的方法生成；生成 Run `01a09e36-d6b8-75f6-8cf1-0e79a27339b2` completed。代理审阅保留原候选，并明确修正单选渠道、参数化日期、敏感字段测试与订单任务的范围；固定 v3 摘要为 `sha256:b6cad0a7bf5c6ee84ee1322ed553e4c4588f246359efecdb37be2c4fa77b8453`。这是代理审阅，不是人工点击验收。

首次试跑的空 `sessionId` 在发送前被 parser 拒绝，但异常未形成模型可修复的结果。现已将纯输入解析失败收敛为稳定、有界的 `completed/isError`，并覆盖 Worker 在结果提交前重启的恢复；身份、政策和租约错误仍保持原有严格语义。

第二次试跑 `01a09e42-c0b0-71c9-b0c2-ca24e9d1c74d` 反复猜测 `sessionId`，没有浏览器效果。实际调用和回执保存在 `optional-session-trial-failure.json`。Responses 工具序列化未发送 `strict`，而[官方协议](https://developers.openai.com/api/docs/guides/function-calling#strict-mode)说明省略时服务端会尝试规范化 schema 为 strict；这与可选字段始终被填充的现象一致，但未把服务端内部行为当成已直接观测事实。`b6bd56205` 为 function 工具显式发送 `strict: false`，保留本地 optional/union 语义；custom 工具不变，宿主输入与授权校验不变。真实 HTTP、Responses Lite 与 WebSocket 请求捕获回归先红后绿，agent-responses 全部 125 项测试和类型检查通过，Worker 相关 13 项检查通过。

第二次试跑还暴露 Worker 的续租快照问题：heartbeat 更新了存储，却未更新随后构造 Tool command 的旧 `expiresAt`。`5a912c9b2` 在每次实际工具调用的容量预约和派发登记前，从权威存储续租并使用返回的新 claim；过期或被别的 owner 接管时仍不派发。SQLite/真实 Worker/Responses SSE/浏览器 HTTP adapter 回归覆盖两轮执行跨过原截止时间，以及过期、接管两种拒绝。相关 30 项通过、22 项 PostgreSQL 因未配置跳过，既有 Worker tool/lease 检查和 F01 10 MiB 崩溃恢复检查通过，类型与边界检查通过。

为满足模型自动交付，新增明确审阅的 v4（`sha256:088c42233a749115c364dfa2a5b8f5b21ca4d6b1af66adc1075dd7b5c9e6329e`），加入 `delivery_assemble` 和汇总/明细读取。原始 C01、真实 generation、v3 及失败证据保留。既有 XLSX 模板通过 F01 预置为输入；验收脚本不调用 assemble，只在实际模型工具请求与模板、下载输入、映射和规则完全一致后，按既有明确授权通过正常单次审批接口决定。该审批不作为无人值守日程能力证据。

## 可复用方法修订与再次真实试跑

v4 的方法包含测试期订单号及预期金额，因此保留其通过记录，但不把它当作最终可复用方法。v5 `sha256:3a64fab98a1cfa135d58c8e094d0412f419e3f3830e93144baa55e1e871673ea` 移除这些具体答案，要求根据当次真实 CSV 筛选、逐条追溯并求和；业务排除规则、映射和模板保持一致。方法 JSON 不包含固定订单号、金额或日期，日期只在调用参数中提供，200.00 只在独立验收中断言。

`artifacts/f05-real-reusable-skill/` 保留 v5 真实试跑：Run `01a09e55-ef4a-764a-8642-3931fa9c21b9` completed，24 个模型调用和 16 个浏览器/文件回执；模型实际下载 input `e42cdde8-e391-4262-87b5-500bbe6067b5` 并生成 XLSX version `bf8160cb-2e66-476b-8a84-0c007aebc1d0`，8531 字节，摘要 `sha256:3f3c14cb0febdfb7fb4803ffab88688fc280c5d3ad889208ce82812e63a304ac`。独立读取汇总为 200.00，重启后 CSV/XLSX 字节相同，F03 review 已保存；仍明确记录首次具体文件审批。后续真实 E05 使用该 v5。

`ea7c1faa8` 补齐自动批准与 scoped grant 的组合边界：所有浏览器动作入口都遵守已选 scope，不能换为普通 act 绕过；缺少固定 Skill、错版本、参数/目标/导航越界和撤权均拒绝，匹配范围及既有无 scope perAction 路径保留。8 个新增 Host 用例中 5 个在原实现真实失败；修复后 Host+grant 48/48、Electron 类型和 boundary 检查通过。界面也明确自动批准仍受范围约束，组件既有快照已更新验证。

## 同一固定 v5 的真实日程 E05

`artifacts/f05-real-schedule/` 保存实际日程定义、调用绑定、浏览器授权、模型历史、自动审批回执、CSV、XLSX 和原页面截图。脚本通过真实 F03 activate 审核已通过的 v5，再使用现有 Control API 创建 once 日程；没有 run-now、直接创建 Run、伪造 occurrence、HTTP assemble 或逐动作脚本审批。

- 明确选择整个 Run 的既有 `approveForMe` 模式并写入定义；该模式不是只授权 assemble，浏览器 grant 仍独立约束范围。F01 perAction 默认未放宽。普通默认/requestApproval 仍暂停，模式被冻结至真实 Run，相关模式用例 10/10 通过。
- Automation `01a09e60-ce62-766b-9ca5-b214e8d224e3` 在 `05:25:39.554Z` 创建，实际到期 `05:25:54.497Z`，现有 scheduler 于 `05:25:55.130Z` 创建 Run `01a09e61-0b3a-74fd-a443-ca28e729fc88`。只读核验 invocation receipt 唯一，并匹配 scheduler 的 `scheduled:b84e2578418c1806040a3aa9450d633ad26f1154998e8fe11ee416355e3bd771` 键、固定 v5、当次参数和交付目标。
- Run completed；24 个真实模型调用、17 个工具回执。实际下载 CSV input `551a19ef-1d14-4bae-b900-8be3aadd3061`；模型调用 `delivery_assemble` 保存 XLSX version `455877f7-cb85-4033-a619-40907f54da97`，8532 字节，摘要 `sha256:5e7b330b43c5d5b8d11af424ef450df8fceea77819a73d923048f40acf1b8c1e`，来源 Run 和两个实际输入均匹配。
- 唯一文件审批由真实 Worker 根据已保存的模式记录：`Approved by approveForMe Run permission`，required `05:27:03.859Z`、approved `05:27:03.861Z`。测试脚本未批准动作。独立 SheetJS 从实际文件读取 direct/CNY=200.00、两条明细；Runtime 重启后两个文件逐字节一致、浏览器授权为空。
- 再次启动真实 Supervisor，复用完整持久请求（包含原 expectedThreadRevision/dueAt/idempotencyKey），查回同一完成 occurrence；不新建浏览器授权、不新增模型调用或工具回执、invocation receipt 仍为 1，文件版本/字节相同。`recovered-result.json` 与 `replay-verification.json` 单独保存，未覆盖首次证据。

helper 的真实 Control/SQLite/scheduler/Worker 回归 4/4 通过，含两种模式、完成后原请求重放、未审阅激活拒绝。最初两项超时来自测试模型只返回 completed 而没有合法非空消息，增加一条明确 fixture 的 output.delta 后通过；未延长超时或修改 scheduler 来遮蔽失败。

显式审批模式 UI 接线也已合入；模式文案不授予浏览器权限，旧调用方仍默认 requestApproval。最终本树 8 个相关 UI/客户端文件共 98 项检查通过，UI/Electron lint、Control 类型、boundary 和 pnpm format 通过。所有临时 Electron/Worker 和 60279 合成站点进程已结束；实际数据目录保留供只读复核。

复现先启动 `scripts/serve-recording-fixture.ts`，再构建宿主和 `scripts/browser-execution/real-skill-acceptance.ts`。首次运行走 generation/代理审阅/试跑；复用实际数据目录以 `CREWON_F05_EXECUTION_PATH=schedule` 选择日程，`CREWON_F05_REUSE_DATA_DIRECTORY` 指向该目录。授权的 provider env 路径作为唯一 argv 参数。需要恢复时保留 `schedule-request.json`，不能重新生成 key 或 dueAt。合成站点和真实数据目录相互独立；本验收没有覆盖企业登录、人工/CUA GUI 或非标准控件。
