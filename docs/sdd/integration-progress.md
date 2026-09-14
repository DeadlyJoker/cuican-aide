# 隔离集成进度与证据

2026-09-14。协调工作区：`/Users/cheneywang/project/wqc/cuican-aide-sdd-integration-20260914`；分支：`codex/sdd-integration-20260914`。原工作区和各 feature 工作树不修改，未合回 main、未 push 或发布。

## 当前结论

2026-09-14 后续修复：**0.1.5 DMG 已校验、覆盖安装并完成本机 GUI 验收**。多工作空间新增及固定会话归属、A/B 实际目录读取、首次发送、图片预览/保存和重启恢复均通过；无用导航已移除。根完整 UI 445 文件 / 3129 项通过，UI/Electron 类型与入口边界通过。真实安装版图片任务约 28 秒生成 2,041,789 字节 PNG，0.1.5 重启后保存文件摘要一致。企业微信与公开签名公证仍未完成。见 [安装记录](dmg-installation.md) 和 [最终证据](evidence/desktop-0.1.5-checks.json)。

App 入口复核补充：发现并补齐当前任务文件用于试跑、浏览器限定范围配置、日程重授权三个界面缺口；补齐后全 UI 437 文件/3031 项通过。本次登录后验收覆盖任务、图片和工作空间；录制到日程的全部人工操作入口尚未逐项重跑，单条日程暂停/编辑/删除尚无完整入口。请同时阅读 [App 可用性复核](app-readiness-review.md) 和 [使用说明](../crewon-app-user-guide.md)，不要仅凭下面的脚本闭环证据认定全部产品入口完成。

本轮功能代码已在本隔离分支集成。受支持的单个 CrewON 浏览器和本地 SQLite 文件路径已完成“实际录制 → 真实模型草稿 → 明确审阅的通用 Skill → 新输入试跑 → 同版日程到期 → 模型产出 XLSX”的联合验证。

- 最终日程输出 [实际 XLSX](../../artifacts/f05-real-schedule/second-period-orders.xlsx)：8532 字节，两条明细，direct/CNY 汇总 200.00。模型实际调用 assemble，来源指向新的日程 Run；[根独立文件与身份核验](evidence/scheduled-file-review.json) 与 owner 的真实执行证据分开记录。
- 同一日程请求重放仍为一个 Run、一次 invocation receipt、24 次模型调用和 17 条工具回执，文件版本与字节不变。既有 Worker 根据显式保存的 approveForMe 完成审批，验收脚本没有逐项批准或代做文件。
- 根最终 UI：436 文件/3010 项通过（`--maxWorkers=2`）；模式、调度和文件联调：54 项通过。类型、UI 构建、桌面 runtime/host 构建及分阶段检查见 [机器可读记录](evidence/integration-checks.json)。各次检查保留其源码版本和范围。
- 限制：合成业务材料与代理审阅，不是用户试点；人工/CUA、企业登录和远程/Postgres 新交付未验证。既有 package 架构检查 3 项失败，23 条违规无新增。F03 默认并发全 UI 曾遇到既有 soak 5 秒超时；受限并发全量通过，未放宽测试阈值。

以下保留分阶段集成历史，早期“待验收”描述以本节当前结论为准。

## 首批输入与合并处理

- F04 完整消费端提交：`3e3200d47b9f6476d21cde1a7713da895cb19ebf`，作为本次集成基底。
- F03 已提交宿主/身份/导入修复：`33e0a04cd84d5937a0a9b46b48f0545cab4e1e78`，包括 `bd1e2f309` 和 `d6c894f06`。真实模型生成、UI等未提交部分未复制。
- 因 F03 分支带有较旧的 C04 核心副本，15 个文件发生文本冲突。逐块保留 F04 最新的具体参数冻结、readiness、目标范围与兼容校验，合并 F03 的服务、端口导出、路由和客户端传输。
- 自动合并还重新引入 run-now 路由的额外 `getAutomation` 预读，首轮回归使仅有运行权限的旧客户端返回 403。移除该重复预读，保留 application 层的支持版本校验；不能以没有冲突标记代替行为检查。

## 已实际执行的检查

使用 Node 24 与 pnpm 10，独立依赖安装 `pnpm install --frozen-lockfile`；未更换锁文件版本。

窄回归覆盖以下八个文件：

```text
apps/control-api/src/automation-v0-compatibility.test.ts
apps/control-api/src/automation-skill-schedules.test.ts
apps/control-api/src/automation-bff-compatibility.test.ts
apps/control-api/src/demonstrated-skill-adapters.test.ts
apps/control-api/src/demonstrated-skill-routes.test.ts
packages/store/src/demonstrated-skill-integration.test.ts
packages/store/src/demonstrated-skill-store.test.ts
packages/store/src/skill-recording-store.test.ts
```

命令为 `node --experimental-strip-types --test --test-concurrency=4` 后接上述路径。首轮 40 通过、1 失败，原因如上；修复后重跑 41 通过、0 失败、0 跳过。覆盖真实 SQLite 恢复、授权/身份反例、BFF与新旧客户端兼容；其中模型或 Skill 准入使用夹具的部分仍是夹具，不宣称真实模型 E04/E05。

Control API、Store、Control Client 类型检查、OpenAPI 生成一致性和 TypeScript 边界检查已通过。不沿用 feature 各自工作树的测试结果冒称本集成结果。

## 分批接线和验收记录

第二批已合并 F03 `12b9a7a50`（包含 Zod/js-yaml 复用、模型草稿生成 Run 持久化 `eb5b211e3` 和 F04 真实宿主测试）。AutomationApplicationService 已注入 skills，Skill 宿主已接入 `scheduledInvocations` 的权威 Run 映射。合并时去除自动合并产生的重复 import/export，保留首批修复的旧客户端运行权限行为。

本树新增实际验证：生成路由、生成 SQLite 恢复、严格 schema、standalone 宿主、真实 Skill 日程宿主及兼容性八个文件共 32 项通过、0 失败、0 跳过；Control API 类型检查通过。日志位于 `/tmp/crewon-integration-generation-host-tests.log`。真实宿主测试的已激活 Skill 是合成前置数据；生成生命周期测试的提供方输出是显式夹具，这些不证明真实模型生成成功。

F04 的 SQLite 原子性修复 `ff84a9e80` 已取入本树 `7ec329c4f`：保存日程和创建新 Run 时，在同一事务内复用完整 Skill 行校验；旧 v0 和既有 receipt 早返回行为保留，Postgres 新 v1 明确拒绝。根协调运行真实宿主交错禁用/损坏、旧客户端、Skill Store/直接 Turn/生成恢复七个测试文件，40 项通过、0 失败、0 跳过；Store/Control API 类型检查、OpenAPI 生成一致性通过。日志 `/tmp/crewon-integration-skill-fence-tests.log`。它不替代执行中每次浏览器动作的撤权检查。追加 `9d241ee3d` 后，手动模式保存不再用 9999 年调度占位值解析日期，实际执行仍按当次发生时间冻结。

第三批已合并 F01 `3745d6a797a2eb9f560aefe4dd1f91797da1154a`：ExcelJS/csv-parse/xlsx-calc 表格处理、加密文件与版本 CAS、Worker 工具与下载导入、Control/客户端接口、BFF/桌面/代理上传预算。C03 沿用 owner 新增的可选数字格式和输入 Run 来源字段，同时保留 F03/F04 的契约入口。BFF 保留 `x-crewon-automation-version` 转发。

本树实际运行文件/表格/客户端/HTTP/BFF/日程兼容/Worker 恢复十五个测试文件，共 63 项通过、0 失败、0 跳过，日志 `/tmp/crewon-integration-delivery-tests.log`。其中 E01/E02 读取真实生成的 XLSX，属于合成业务材料的实际文件验证。Control API、Runtime Worker、Web BFF、Control Client、Store、Artifacts 六个包类型检查通过。尚未用真实模型把这些文件操作与录制流程贯通。

第四批已合并 F02 `4cdadfa09bb8fa6954bd4030615cd10994d90d45`，包含 C01、成熟可访问语义模块、Electron 录制宿主/持久化/受控截图、录制回看界面和向主窗口交接端口。desktopBridge 同时保留录制与浏览器执行授权接口。根协调在本树运行五个匹配的录制宿主/来源/存储/导航/界面测试文件，98 项通过；UI 与 Electron 类型检查通过，日志 `/tmp/crewon-integration-recording-tests.log`。追加 `001a2799c` 保护标记/下载关联修复后，录制宿主 10 项通过，Electron host 构建通过。这些是自动化测试，尚未证明真实模型消费或实际用户 GUI 操作。

第五批已合并 F01 UI 与最终 feature 证据 `14b8fc895e36abd2faa762fd01634a8b4fb2a5e8`。复用 App 的 Control 客户端，在任务工作台接入文件交付。根协调在本树运行交付面板、任务工作台、Skill 日程与浏览器授权四个组件文件，24 项通过；UI 与 Electron 类型检查通过，日志 `/tmp/crewon-integration-delivery-ui-tests.log`。feature 中的文件/GUI 证据保留其原始验证范围，不等同于根协调重新完成整体验收。

真实模型、浏览器取数、文件结果及完整周期执行的 E04/E05 尚未验收；此树当前用于逐批集成，不作为已可发布成品。

第六批已合并 F03 `505cbeeb9`：固定生成角色通过正式 release/binding 发布，`maxToolRounds: 0` 在首次流式采样、动态 goal/plan、审批与恢复入口均禁止工具；手写 C01 的 fixture 标记只允许降级。根协调补齐 C03 接线：同一 `DeliveryApplicationService` 同时供 HTTP 和 Skill 目标写权限校验，缺少交付存储仍拒绝。新增真实 standalone/SQLite 回归验证带交付目标的日程保存、到时 Run 准入与重开，以及缺少目标验证器时拒绝保存。

本树第六批九个测试文件共 51 项通过、0 失败、0 跳过；Control API/Runtime Worker 类型检查通过，日志 `/tmp/crewon-integration-generation-delivery-authority-tests.log`。F03 另报告真实提供方固定无工具生成成功：一次模型调用、零工具回执、候选确认后草稿 revision 增加；输入为显式 contract-fixture，未激活。该报告尚不等于真实录制试跑或周期交付验收，原始 evidence 随其最终提交补入。

F03 真实模型/独立 Control 进程重开证据 `86d37ead2` 已取入本树；重开后的 GET/collect/apply 重放保留原 Run 和 revision，模型调用数未增加，这只证明完成后的 HTTP 恢复。F02 最终 `45b8ee383`/`aa81fecb0` 也已合入：重复 arm 与排队下载生命周期修复、实际 source 导出及同端口站点复现脚本。根协调运行两个变更宿主文件，13 项通过；锁文件合并后 frozen install 通过。实际录制数据位于 `artifacts/f02-recording/recording-export.json`，站点和业务材料合成，采集链路是真实 Electron。

第七批已合入 F03 UI `ee79f42c8`：录制交接、模型候选审阅、版本/试跑/启用、浏览器授权与 Skill 日程入口。保留 F01 App 的 DeliveryClientContext，同时接入录制导入 hook。根协调运行 Skill/导入/日程/交付等十个界面测试文件，58 项通过；UI/Electron 类型检查通过，日志 `/tmp/crewon-integration-skill-ui-tests.log`。F05 正在用实际 C01、真实模型与第二周期数据执行联合验收，尚未结束。

第八批已合入 F05 完整接线历史至 `13bf049a1`：同一 F02 视图上的 Puppeteer driver、显式可撤销 grant、实际 Run 事实读取、认证本机桥、持久效果回执、下载字节向 F01 导入，以及桌面 Supervisor 启动/退出接线。保留根已有最新 UI、能力请求头、C03 validator 与 F02/F04 证据。清理自动合并产生的重复交付属性、导出和关闭调用。Puppeteer 作为单一生产依赖，复用 F02 已验证的公开 SHA512 锁条目和 modern-tar 0.8.5。

根协调在本树运行 host/driver/授权/下载/录制十一文件 138 项、Control/Worker/交付恢复/契约八文件 37 项，均通过、无跳过；Control API、Runtime Worker、Contracts、UI 与 Electron 类型检查通过。日志分别为 `/tmp/crewon-integration-browser-host-tests.log` 和 `/tmp/crewon-integration-browser-runtime-tests.log`。包含真实 Worker/HTTP/10MiB 文件持久恢复，但不把脚本模型场景记为真实提供方执行。后续身份切换修复与联合验收进度见下一节。

## 当前整体验证与已知限制

已取入 F03 `16e5c67be` 的身份切换修复及最终证据。总 UI 首跑 2971 通过、1 失败：新 Skill 宿主集成测试从底层组件目录引用 app 协调模块，触犯现有架构规则。根以 `269a4c8f9` 将原测试移至 app 同层，仅调整三个 import，全部断言和规则保留；22 项窄验证通过后，第二次完整 UI 为 **434 文件 / 2972 项全部通过**。

F05 真实模型首先暴露空 sessionId 被严格拒绝后没有反馈给模型的问题。已合入 `d8d601ec9`：只将合法 Tool 命令内、尚未发送到宿主的参数错误返回有界 `isError`，协议/租约错误及已发送动作的不确定结果保持原语义。根验证真实 Worker 的模型纠正、提交前崩溃及下载恢复共 19 项通过；工具描述与最终桌面指纹 `v1.2` 的两个后续提交一起取入，Supervisor 15 项通过。实际提供方重跑由 F05 继续，先前失败 Run 的证据保留。

当前组合的 Control API 全套 **212 通过 / 5 跳过**，Runtime Worker 全套 **470 通过 / 46 跳过**，Contracts **118 通过**；所有 packages 类型检查通过。实际执行了当前代码的 UI build、桌面 runtime stage 与 Electron host build，均成功，保留既有体积/模块类型警告。完整 UI 执行在上述最终指纹微调之前，微调后只重跑受影响的 Supervisor，未冒称重复跑了整套 UI。

packages 架构测试仍 **6 通过 / 3 失败**。本树 23 条违规逐项与基线证据比较，无新增违规，未放宽既有检查。不能称整仓全绿。详细计数、验证范围、原始日志摘要与已知缺口见 [集成检查记录](evidence/integration-checks.json)。

F01 新增 50 个公开包已改为核验过的官方 HTTPS 下载与 SHA512，原版本/依赖图不变；其误改的既有 tmp resolution 已恢复。根 frozen install 通过，公开 tarball 的逐包下载证据由 F01 保留。历史基线的其它内部源未改，不能据此承诺整个历史依赖树已能在外部 CI 安装。

F05 已在同一真实 WebContentsView 上验证 Puppeteer 动作、下载和 focus emulation 恢复，脚本模型下的 Supervisor/Worker/授权/文件导入路径也已有独立证据。真实提供方消费实际录制后的联合试跑仍未通过：第二次失败继续暴露 Responses 工具参数序列化和 Worker 续租后传递旧租约的问题，正在修复并保留失败证据。不能将这些阶段性验证称为完整 E05 或人工 GUI 验收。已有模型配置只供隔离验收进程读取，使用合成业务材料；凭据不复制、不输出，不使用原用户数据库。

已追加 Responses `b6bd56205` 与 Worker `5a912c9b2`，根分别取为 `c3b065a8b` / `03d6c2d41`。前者明确发送 `strict:false` 保留已有可选参数与联合 schema，不更改工具本地校验；根完整 Responses 125 项和类型检查通过。后者在工具派发前取得 Store 返回的新租约，并将同一新租约用于命令与持久 dispatch；根跨原期限、失租/新 owner 拒绝、真实浏览器/文件恢复与工具续跑五文件共 25 通过、7 个 Postgres 条件跳过，Worker 类型检查通过。此前完整 Worker 计数与构建仍按原 source 记录，不冒称是在这两个后续提交后执行。

F05 实际录制来源的首次真实模型交付证据 `34053bcbb` 已合入根 `da57a7764`。唯一 add/add 冲突是复现脚本的 source 路径：保留 F02 原始路径，逐字节确认 F05 归档副本与原始 C01 一致。根独立读取提交的实际 XLSX，8533 字节与摘要一致，明细 A101/A103、direct/CNY 汇总 200，来源与 assemble 回执均关联同一完成 Run。根没有重跑提供方或 Runtime 重启；重启逐字节相同由 owner 的实际证据支持，见 [根文件核验](evidence/real-trial-file-review.json)。此次包含一次正常具体审批，且审阅后的 v4 方法内嵌当期验收 ID/金额；正在移除这种验收答案依赖并用通用完成条件重做固定版本试跑。原 v4 成功与此前失败证据全部保留，尚不标为 E05 无人值守通过。

可复用 v5 的真实试跑证据 `94c6934e1` 与所有浏览器动作受同一 scoped grant 约束的修复 `ea7c1faa8` 已合入根 `7e2ee0b54` / `2c6db5b06`。v5 方法不含当期订单号、日期或预期金额，根再次独立读取实际 8531 字节 XLSX，摘要与来源 Run 一致，明细和汇总正确；16 条工具回执均完成。见 [可复用方法文件核验](evidence/reusable-trial-file-review.json)。根运行 Host 与浏览器授权 UI 两文件共 **45 项通过**。这次试跑仍有一次明确具体审批；F01/F03 正补齐已有审批模式的显式请求/日程保存与 UI，F04 准备真实 occurrence helper，E05 仍待执行。

已合入 F01 显式审批模式 `3e5d6af1d`（根 `99cd3d53d`）：仅本次执行/Skill 日程顶层显式选择 requestApproval 或 approveForMe，缺省请求批准；模式冻结并在事务、Run 绑定、receipt、解析及客户端回显逐层校验。v0 不接受新模式字段，旧 v1 未携带该字段时保留原始摘要，执行按请求批准。F01 工具的 perAction 策略不改。F04 helper 通过真实 activate/create/到期调度及只读 receipt key 验证，不调用 run-now、approve 或 assemble。

根首次相关八文件组合 52 通过、2 失败：helper 测试用模型只发送完成事件、没有正文，实际 Worker 因 message_content_invalid 重试。F04 `8dba99f82` 仅补一行有效 output.delta；同组合重跑 **54/54 通过、0 跳过**，保留首次失败日志，未放宽超时或调度行为。根全部 packages、Control API 与 Worker 类型检查通过。真实 E05 已由既有 scheduler 产生独立到期 Run，正在等待最终文件和重启核验；界面模式选择由 F03 收尾。

F03 审批选择 UI `a77cd9f2b` 已合入根 `541056f4f`，复用现有 CommandComposerSelect；试跑与日程分别默认请求批准，明确选择后冻结本次请求，丢失响应重试保持原模式，已绑定执行后的新尝试恢复默认。运行记录与日程卡回显保存模式，范围说明明确为整个任务的工具审批。两处合并冲突仅是 F05 已有 scope 文案的格式和新增快照，保留新版完整内容。根九个受影响组件/客户端文件 **104 项通过**；包含身份失效、重试及浏览器授权文案。权限/范围修复后的 desktop runtime stage 与 Electron host build 也已通过。

最终 E05 `bf30d7f67` 已合入根 `0c689cb1e`。根独立核对实际 8532 字节 XLSX 的摘要、明细、汇总和新的 sourceRunId，以及原始与重放证据中的同一 Run、版本、24 次模型调用和 17 条工具回执。此前 v4、v5 试跑及失败资料未覆盖。F05 测试站点与 Electron/Worker 进程已由 owner 关闭。

最终 UI/lint/build 已在根执行：UI 全量 436 文件/3010 项通过，并发为两个 worker，未改变断言或时间阈值。最后追加的 F05 提交仅为验收脚本与证据，不修改产品代码。原工作区只同步本任务的协调文档，产品实现保留在隔离集成分支，未 push、未合回 main。
