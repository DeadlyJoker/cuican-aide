# F04 验收证据

状态：S2 消费端实现与兼容检查完成；S3 真实产品闭环待 F03/F05 集成。基线 `79bf09d88`；S1 `09b51b49c`；首个实现 `ae3d3c285`。所有工作在本任务工作树，无 push/发布/合回原始 main。

## 需求与可重复行为证据

| 需求              | 测试/来源                                                                                         | 结果与证据边界                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 v0 兼容       | `apps/control-api/src/automation-v0-compatibility.test.ts`                                        | 固定 JSON、definition/instruction digest、旧 HTTP 表示恒等；真实 SQLite 旧行（无 principal 字段）跨 DST 离线最新 occurrence 与重启重放                                                                           |
| R01 混合客户端    | `packages/store/src/automation-version-pagination.test.ts`、`automation-skill-schedules.test.ts`  | 内存/SQLite 过滤在 LIMIT 前；旧 list 只见 v0、新客户端混合读取；旧 v1 get/run/create 409 标准错误；旧只有 run 权限仍 201、不新增 read 权限要求。PG 未配置跳过                                                    |
| R01 BFF 透传      | `apps/control-api/src/automation-bff-compatibility.test.ts`、`apps/web-bff/src/web-bff.test.ts`   | 真实 ControlApiClient → Web BFF → Control HTTP handlers，能力头透传/缺省保留、保存读取及 readiness。C02 为显式夹具                                                                                               |
| R02 固定绑定/日期 | `packages/domain/src/automation-parameter-bindings.test.ts`、`automation-skill-schedules.test.ts` | 固定版本与方法快照，运行日/上一完整周按 occurrence+时区解析；纽约重复小时、沪/洛跨日、跨年周界；规则/参数限额拒绝。新日期值写入 invocation binding                                                               |
| R03–R04 准入      | `automation-skill-schedules.test.ts`                                                              | 保存和首次触发分别检查 C02；缺端口、非法参数、伪造 context、撤权/未激活/缺失/摘要/离线/目标/预算拒绝无半个 Run；当前 readiness 显示可恢复代码。真实 C02 parser/renderer，准入返回及可用状态为端口夹具            |
| R05 持久恢复      | 同上，memory/sqlite 双后端                                                                        | 丢 ack、scheduler 重启、同 occurrence 重放只有一个消息/Run/WorkItem；撤权后历史 receipt 仍可重放但不新增执行；实际 SQLite 文件关闭重开                                                                           |
| R06 取消/运行身份 | 同上                                                                                              | 复用 RunApplicationService.requestCancel，持久 cancelRequested；取消后重放仍同 Run。`resolveAutomationSkillForRun` 从 SQLite 真正 Run origin 和定义返回已冻结参数，当前日期跨月后不改变；跨 scope 与篡改参数拒绝 |
| R06 流式 Worker   | `apps/runtime-worker/src/runtime-worker.test.ts` 的 F04 用例                                      | 真正 AutomationApplicationService → Store → WorkItem → RuntimeWorker，固定日期内容进入流式模型请求并完成；伪造队列参数在模型调用前拒绝。模型 transport 明确为 deterministic fixture，不是真实模型                |
| R08 UI            | 7 个相关 UI 文件，70 项通过                                                                       | 固定版本/类型化参数/日期规则/目标不匹配/取消/离线/失败文案/动态readiness；DOM 提交 → 真实 ControlApiClient → fixture HTTP → Run adopter/openThread。已有 v0 快照保持，新增 Skill 表单与状态快照                  |
| R09 边界          | `crewon:boundary:check`、域限制测试                                                               | Node 24/pnpm 10，未引入新 scheduler、轮询、运行时或 F04 新包；instruction ≤9,999 UTF-8 bytes，C02 context ≤9,216 bytes；配置/参数有界                                                                            |

## 实际检查记录（2026-09-14）

- `pnpm crewon:boundary:check`：通过。
- `pnpm --filter './packages/**' -r typecheck`：通过。
- `pnpm --filter @crewon/control-api typecheck`：通过。
- `pnpm --filter @crewon/control-api test`：180 通过，5 跳过，0 失败（185 项）。
- `pnpm --filter @crewon/runtime-worker typecheck`：通过；全量 test：436 通过，46 跳过，0 失败（482 项）；新增 F04 流式/篡改用例之后窄跑 1 项通过。
- 相关 domain/application/contracts/control-client/store 包 test：分别 138/175/112/103/458 通过，Store 94 跳过，0 失败；其中 contracts 包包括生成代码与许可检查。
- `pnpm --filter './packages/**' -r test`：未通过，test-contracts 架构测试报告现有四处导入 `main.ts → node:net`、`paused-admission.ts → node:stream`、`pim-sandbox-client.ts → node:path`、`provider-settings-native-coordinator.ts → node:readline`。这四文件与共享基线无差异，未放宽规则；随后单独运行受影响五包，结果如上。
- Web BFF：16 测试通过，typecheck 通过；Client→BFF→Control 新用例 1 通过。
- UI 相关窄跑：7 文件/70 项通过。UI lint、生产 build 通过。
- 技能要求的 `pnpm --filter @crewon/ui test -- CommandWorkspace` 实际运行全部 UI：411 文件/2678 项，2675 通过、3 超时（electron/localWorkspace 两项、soak/trend 一项）。保留该失败结果；两个文件原样单独重跑共 13 项通过，不能把它写成一次全量全绿。
- `pnpm format`：通过；本目录 Markdown 和新增源码单独格式检查。

## GUI 与真实集成限制

### F03 standalone 宿主垂直验证补充

`apps/control-api/src/automation-skill-host.test.ts` 使用真正 `createStandaloneControlApi`、认证 HTTP、SQLite Skill/Run Store、`ConfiguredSkillExecutionAuthorization`、已持久化 AgentVersion release 和现有 scheduler。前置的已激活 Skill 版本是明确标记的合成测试数据；不模拟 C02 准入、SkillService 或准入授权，也不声称此数据经过真实模型试跑。

两项验证通过：保存固定版本日程；到时触发前禁用则没有 Run/消息/WorkItem 且 readiness 显示阻塞；恢复后触发，冻结发生日与时区解析值；修改未封存草稿不改变执行版本；认证 Run lookup 经 `ensureRunSkillAllowed` 返回绑定，匿名请求 401、禁用后 403；关闭并重开真实宿主后同 occurrence 回执不重复创建 Run，恢复权限后仍读到原参数；取消走现有 Run API；AgentVersion 缺工具时保存 403 且没有日程或 Run。

最初相关六个测试文件共 25 项通过，0 跳过/失败，日志 `/tmp/f04-host-compatibility.log`；Control API typecheck 通过。生产宿主接线现已合入 F03 `eb5b211e3`（本工作树 cherry-pick 为 `34bcb1f7c`），已在该提交上复验。此前本地临时小补丁已替换为 F03 正式提交。不把前后准入检查称为执行中浏览器工具撤权验证。

### 准入与提交之间的真实交错验证

只读复查先在真实 SkillService/SQLite 复现：execute 准入后，另一连接禁用 Skill，再提交 Automation，旧实现仍返回 `committed`，留下 queued Run、一个 WorkItem 和一条消息。该证据只证明入队竞态，不表示工具已执行。

修复后使用认证 HTTP 和真正宿主，在 `commitAutomationCreate` / `commitAutomationInvocation` 边界通过受控交错先执行另一连接的真实禁用，再进入原 SQL 事务。两者均 403、无日程/Run/消息/WorkItem；恢复后同幂等键正常提交；事后禁用再重启，既有 receipt 仍恢复同一 Run。

补充四种提交前权威损坏：缺少版本表、固定版本替换、content_digest 索引列不一致、revision 索引列不一致，分别得到可恢复的 409 代码且没有部分 Run。复查发现的行解码差异已通过复用 F03 普通读的完整解码器消除。

最终宿主文件 8 项通过；相关七个 Control 测试文件 32/32 通过（`/tmp/f04-fence-control-final.log`）；相关 Store/原始 SQLite Run/F03直接Skill/生成/自动化回归 182 通过、6 跳过、0 失败（`/tmp/f04-fence-store-final.log`）；Store、Control typecheck、boundary 通过；UI 恢复文案 24 项通过。新增 PostgreSQL 不支持 v1 新写入的行为测试因未配置 `CREWON_TEST_POSTGRES_URL` 跳过，不能视为 live PostgreSQL 验证。此轮没有重复整仓全量测试，前述全量失败/跳过记录继续保留。

手动日程补充：`manualOnly` 的保存准入和定义字节预算校验使用创建时间，不使用既有 `9999-12-31T23:59:59Z` 调度占位值；后者在正时区还可能溢出 ISO 四位年份。实际手动触发仍冻结当次 server now，定义/占位值和旧 v0 不变。新增真实 SQLite 回归覆盖显式/默认手动模式，跨周验证保存样例与实际运行参数不同且正确，相关 19 项通过（`/tmp/f04-manual-dates.log`），Control typecheck 与 format 通过。

UI 子任务以真正 React 生产组件挂载显式 fixture：1440×900、1280×540、390×640 无横向溢出、提交控件可见；实际选择 previousWeekStart 并提交 version-1；交付目标不匹配时禁用。临时本地预览已清理。该检查不是真实 Skill 生命周期 GUI。

真正 `/#view-schedule` 在当前环境停在登录页，后端 8000 未启动；未据此声称真实上游 UI 成功。Skill 面板「添加到日程」公共 shell 入口及 standalone `skills` 宿主注入由 F03 集成，F04 提供 `skillAutomationDraft` 和可选 `SkillInvocationPort`。无端口时拒绝保存/执行。

未覆盖：真实模型生成/试跑/激活 → 真实浏览器取数 → 真正 XLSX → 到时执行的 E05；真实 C03 目标授权/文件交付；C05 独立显式重复授权以及在途工具撤权；真实 GUI 刷新/进程恢复。F03/F05 owner 已接到可验证 Run 映射端口，resolver 只证明身份、不授予权限。当前不把组件夹具、固定假模型输出或 SQLite 恢复当作这些上游验收。
