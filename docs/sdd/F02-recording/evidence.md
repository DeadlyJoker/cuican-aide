# F02 验收证据

F02 模块实现与自动化验收完成，独立分支 `codex/f02-recording`。基线 `79bf09d88`；原始工作目录未写入。人工/CUA 与 F03/F05 全产品验收仍单独追踪，不宣称完整产品链路已验收。

## 实际运行

2026-09-14，Node 24.19.0、pnpm 10.33.0、Electron 43.4.1。合成订单站点运行于临时 loopback 端口；使用真实教学 BrowserWindow、WebContentsView、打包后的 React 控制页、隔离 preload、IPC 与 RecordingStore。页面有严格 CSP，无 CDN。F05 `790105fd0` 的 `BrowserViewAutomation` 与 inspection 源文件直接用于回归构建，未修改这两个文件或另写 transport。

普通 fill/click 由 Puppeteer 的公开 ExtensionTransport 驱动现有同一 view，未启动其他 Chromium。驱动动作期间启用官方 focus emulation 并在 finally 恢复。Puppeteer select 的合成 change 被 F02 正确忽略；测试另用明确标记的原生 CDP 方向键生成受信任 select change。密码/token 负例同样是合成原生输入，所有这些均为自动化输入证据，不是人工输入证据。

实际通过：

- 开始录制、页面导航、普通输入、选择/筛选、暂停不采集、继续采集。
- 真实 CSV 下载；done=completed，下载 relatedStepId 指向触发下载的点击。
- 敏感输入仅保留 runtime-required；导出不含密码、token、query 的测试原值。
- 删除步骤、保存说明、结束录制、真实 IPC 导出；系统保存路径选择使用 fixture，实际写入文件并重验 C01 摘要。
- 15 个保留步骤、revision 24；包含真实标准控件局部 PNG。证据逐项重验字节数和 SHA-256。几何 SVG 明确标为辅助定位图。
- 1180×820、680×560、1024×560 三种布局没有横向溢出或页脚裁切，页面和回看区均有可用高度；截图已实际查看。
- 另一个真实 Node 子进程写入未结束录制后被 SIGKILL；新进程重开存储后状态 interrupted、未完成下载 unknown、revision 3。该证据是存储进程恢复，不冒充完整 Electron 重启人工验收。

## 可审阅材料

相对仓库根目录 `artifacts/f02-recording/`：

| 材料                                        | 含义                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `gui-result.json`                           | 实际回归结果、输入来源、布局尺寸、证据种类和字节数                                      |
| `recording-export.json`                     | 真实录制链路产出的 C01 样本；网站与数据均为合成材料                                     |
| `evidence/`                                 | C01 引用的 PNG/SVG 正文；文件名按 evidenceId 对应                                       |
| `orders.csv`                                | 合成站点实际下载的文件；录制器没有读取其正文                                            |
| `controller-*.png`、`recording-desktop.png` | 控制 renderer 的 capturePage 截图，**不含原生子 WebContentsView**；中部占位不是实际网页 |
| `teaching-page.png`                         | 单独 capturePage 得到的合成网页截图，仅作测试证据；不属于生产录制导出                   |
| `recovery-result.json`                      | SIGKILL 后新进程恢复结果                                                                |

生产录制只保存经过源检查、截图前后复核的控件局部 PNG；测试整页截图不是生产采集能力。源 mutation、目标变化、超时或 generation 不符时不编码/持久化 PNG。已测试点击处理器弹出敏感内容、文字/属性/几何变化及旧候选借用；重复 armed ACK 不重置候选。

## 检查记录

- C01 全套 112 测试及 contracts typecheck 通过，包含严格 parser、digest、超预算、非法引用、未知版本和合成样本。
- F02 针对性覆盖 source、store、host、navigation、preload、React 组件，共 102 项；包含 UI 组件快照、下载时序、截图前后复核、控制 revision 漂移、来源和 owner 主框架校验、执行租约互斥与撤销、F03 请求关联。
- UI 全套 413 文件、2728 测试通过。首次与构建并行运行时既有 `scripts/soak/trend.test.ts` 的磁盘密集场景超过默认 5 秒；单独以 maxWorkers=4 复跑通过，未改变断言或放宽超时。
- UI lint（renderer 与 Electron 类型检查）、UI build、desktop host build、TypeScript boundary、pnpm format、git diff --check 通过。UI build 保留既有大 chunk 提示。

## 复跑

先按仓库要求安装 Node 24 / pnpm 10 依赖及 Electron，再执行：

```bash
pnpm --filter @crewon/ui build
pnpm --filter @crewon/ui desktop:host:build
node --experimental-strip-types apps/crewon-ui/scripts/run-recording-regression.ts
pnpm --filter @crewon/ui test --maxWorkers=4
```

回归脚本需要 F05 的 `browserExecutionPuppeteer.ts` 和 `browserExecutionInspection.ts`。已集成 F05 时直接运行；分支隔离时将 `F02_EXECUTION_SOURCE_ROOT` 指向含 F05 `790105fd0` 的仓库工作树。它只读取 F05 源文件，在当前 F02 的 dist-electron 构建产物。测试用 `puppeteer-core@25.9.0` 为精确 devDependency；F05 生产执行依赖由其任务维护，整合时做语义合并。

## 尚未宣称通过

Mac 锁屏导致 CUA 无法操作。依协调任务要求未解锁或修改系统设置；人工输入、原生保存选择器、实际业务站点、人工接管识别及 F03 真模型 → F05 执行的全产品路径均未由本材料证明。F02 的 core/fix commits 与实际样本已交协调/F03/F05 集成，主窗口真实认证导入和任务执行授权属于对应任务。

## F03/F05 使用真实来源样本

`recording-export.json` 是源捕获结果，没有手工拼装步骤。当前样本 origin 是 `http://127.0.0.1:60279`，教学起始 URL 是 `http://127.0.0.1:60279/orders?token=DO_NOT_EXPORT_QUERY`，导出中 query 值按规则变为 `{runtime}`。该标记是合成测试材料的运行时占位，不含真实凭据。回归重跑会选择新端口并更新样本，始终以样本 `authorization.allowedOrigins[0]` 为准。

在同一桌面机器上启动复现站点：

```bash
node --experimental-strip-types apps/crewon-ui/scripts/serve-recording-fixture.ts
```

脚本读取当前样本并占用同一 loopback 端口；端口冲突会明确报错，不偷偷换端口。已实际验证页面 `/orders` 与下载 `/export.csv` 均返回 200。站点进程须在 F03/F05 浏览器验收期间保持运行，结束后终止。样本 JSON 与 `evidence/` 配套提供；远程环境不能访问本机 loopback，需在执行桌面机器启动该脚本。需要补齐导航参数时使用合成值，仍经 F03/F05 的实际确认与授权路径。

## 第二周期合成材料补充

为 F05 E04 增加 2026 年 10 月材料：用户在实际日期控件输入 `2026-10-01` 并点击“筛选订单”后，页面表格切换到 A101–A105，下载链接变为 `/export.csv?period=2026-10`。只改日期、尚未点击筛选时不会切换已应用的下载周期。十月包含 A101 direct/CNY/paid 110、A103 direct/CNY/paid 90，以及取消、其他渠道、USD 行；有效直营 CNY 合计为 200.00。未知周期明确不可下载，不能悄悄返回九月数据。

九月默认 `/export.csv` 与 `period=2026-09` 返回原 CSV 字节；已保存的 C01 JSON、摘要、配套证据和九月下载文件未修改。新增两项 DOM+真实 HTTP 行为回归验证实际页面脚本、周期切换及原始材料兼容。另以 F05 driver 在独立真实 Electron view 上执行日期 fill → 筛选 click → 真实下载，结果 completed、5 行原始数据、有效合计 200.00，见 `period-fixture-result.json`；该次使用焦点仿真自动化输入，不是人工操作或新 C01 录制。测试使用临时端口，不占用已有样本的 60279 端口。
