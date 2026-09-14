# 隔离集成进度与证据

2026-09-14。协调工作区：`/Users/cheneywang/project/wqc/cuican-aide-sdd-integration-20260914`；分支：`codex/sdd-integration-20260914`。原工作区和各 feature 工作树不修改，未合回 main、未 push 或发布。

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

## 仍待接线和验收

第二批已合并 F03 `12b9a7a50`（包含 Zod/js-yaml 复用、模型草稿生成 Run 持久化 `eb5b211e3` 和 F04 真实宿主测试）。AutomationApplicationService 已注入 skills，Skill 宿主已接入 `scheduledInvocations` 的权威 Run 映射。合并时去除自动合并产生的重复 import/export，保留首批修复的旧客户端运行权限行为。

本树新增实际验证：生成路由、生成 SQLite 恢复、严格 schema、standalone 宿主、真实 Skill 日程宿主及兼容性八个文件共 32 项通过、0 失败、0 跳过；Control API 类型检查通过。日志位于 `/tmp/crewon-integration-generation-host-tests.log`。真实宿主测试的已激活 Skill 是合成前置数据；生成生命周期测试的提供方输出是显式夹具，这些不证明真实模型生成成功。

F04 的 SQLite 原子性修复 `ff84a9e80` 已取入本树 `7ec329c4f`：保存日程和创建新 Run 时，在同一事务内复用完整 Skill 行校验；旧 v0 和既有 receipt 早返回行为保留，Postgres 新 v1 明确拒绝。根协调运行真实宿主交错禁用/损坏、旧客户端、Skill Store/直接 Turn/生成恢复七个测试文件，40 项通过、0 失败、0 跳过；Store/Control API 类型检查、OpenAPI 生成一致性通过。日志 `/tmp/crewon-integration-skill-fence-tests.log`。它不替代执行中每次浏览器动作的撤权检查。追加 `9d241ee3d` 后，手动模式保存不再用 9999 年调度占位值解析日期，实际执行仍按当次发生时间冻结。

第三批已合并 F01 `3745d6a797a2eb9f560aefe4dd1f91797da1154a`：ExcelJS/csv-parse/xlsx-calc 表格处理、加密文件与版本 CAS、Worker 工具与下载导入、Control/客户端接口、BFF/桌面/代理上传预算。C03 沿用 owner 新增的可选数字格式和输入 Run 来源字段，同时保留 F03/F04 的契约入口。BFF 保留 `x-crewon-automation-version` 转发。

本树实际运行文件/表格/客户端/HTTP/BFF/日程兼容/Worker 恢复十五个测试文件，共 63 项通过、0 失败、0 跳过，日志 `/tmp/crewon-integration-delivery-tests.log`。其中 E01/E02 读取真实生成的 XLSX，属于合成业务材料的实际文件验证。Control API、Runtime Worker、Web BFF、Control Client、Store、Artifacts 六个包类型检查通过。尚未用真实模型把这些文件操作与录制流程贯通。

第四批已合并 F02 `4cdadfa09bb8fa6954bd4030615cd10994d90d45`，包含 C01、成熟可访问语义模块、Electron 录制宿主/持久化/受控截图、录制回看界面和向主窗口交接端口。desktopBridge 同时保留录制与浏览器执行授权接口。根协调在本树运行五个匹配的录制宿主/来源/存储/导航/界面测试文件，98 项通过；UI 与 Electron 类型检查通过，日志 `/tmp/crewon-integration-recording-tests.log`。追加 `001a2799c` 保护标记/下载关联修复后，录制宿主 10 项通过，Electron host 构建通过。这些是自动化测试，尚未证明真实模型消费或实际用户 GUI 操作。

第五批已合并 F01 UI 与最终 feature 证据 `14b8fc895e36abd2faa762fd01634a8b4fb2a5e8`。复用 App 的 Control 客户端，在任务工作台接入文件交付。根协调在本树运行交付面板、任务工作台、Skill 日程与浏览器授权四个组件文件，24 项通过；UI 与 Electron 类型检查通过，日志 `/tmp/crewon-integration-delivery-ui-tests.log`。feature 中的文件/GUI 证据保留其原始验证范围，不等同于根协调重新完成整体验收。

F05 成熟浏览器动作宿主尚未在本树集成。真实模型、浏览器取数、文件结果及完整周期执行的 E04/E05 尚未验收；此树当前用于逐批集成，不作为已可发布成品。

第六批已合并 F03 `505cbeeb9`：固定生成角色通过正式 release/binding 发布，`maxToolRounds: 0` 在首次流式采样、动态 goal/plan、审批与恢复入口均禁止工具；手写 C01 的 fixture 标记只允许降级。根协调补齐 C03 接线：同一 `DeliveryApplicationService` 同时供 HTTP 和 Skill 目标写权限校验，缺少交付存储仍拒绝。新增真实 standalone/SQLite 回归验证带交付目标的日程保存、到时 Run 准入与重开，以及缺少目标验证器时拒绝保存。

本树第六批九个测试文件共 51 项通过、0 失败、0 跳过；Control API/Runtime Worker 类型检查通过，日志 `/tmp/crewon-integration-generation-delivery-authority-tests.log`。F03 另报告真实提供方固定无工具生成成功：一次模型调用、零工具回执、候选确认后草稿 revision 增加；输入为显式 contract-fixture，未激活。该报告尚不等于真实录制试跑或周期交付验收，原始 evidence 随其最终提交补入。

F05 已报告同一真实 WebContentsView 上的 Puppeteer 动作、下载和 focus emulation 恢复探针通过；尚未贯通本树的录制/授权/交付路径，不能冒称人工 GUI 验收或完整后台执行。已找到原工作区现有模型配置，F03 将只在隔离验收进程读取，使用合成材料验证；凭据不复制、不输出，不使用原用户数据库。
