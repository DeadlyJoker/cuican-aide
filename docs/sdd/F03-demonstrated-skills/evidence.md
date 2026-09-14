# F03 验收证据

2026-09-14：S1 设计与 S2 实现已建立。基线 `79bf09d88`，独立分支 `codex/f03-demonstrated-skills`。

| 证据级别                                     | 状态                                       |
| -------------------------------------------- | ------------------------------------------ |
| 源码现状调查、边界设计                       | 已完成，见 design.md                       |
| C02/生命周期行为测试                         | 已通过，见实际检查                         |
| SQLite 持久化、重开/并发恢复                 | 已通过行为测试                             |
| 现有真实 Turn/Run 链路（可使用明确模拟模型） | 测试及一条真实 provider 生成均通过         |
| UI 组件/快照与浏览器布局                     | 185 项通过，三尺寸契约样本布局通过         |
| 真实 F02 录制 + 模型 + 浏览器 + F01 XLSX     | 待依赖与验收，不能以 contract fixture 代替 |
| 新日期、新输入、可处理异常、断线恢复         | 待真实闭环验收                             |

本文件中的“通过”只对应明确实际运行的检查，不代表未执行的产品闭环已完成。

## S2 独立实现与实际检查

- `bd1e2f309`：持久化草稿/版本/录制证据、C02准入、真实Turn的SQLite事务绑定；`d6c894f06`：认证Control路由、Run身份查询与本地宿主。
- 2026-09-14：`node --test` 针对 Turn service、C01 importer、Skill integration/store、recording store 共35项通过。覆盖真实SQLite重开/双连接、附件校验/完整事务回滚、版本不变、准备文本不一致拒绝、Run提交后中断重试同一Run、禁用提交窗口无Run/消息、运行中再准入拒绝。
- Control routes/adapters + ControlClient transport 共12项通过，覆盖Session/CSRF、固定Run身份、当前禁用、未知Run、证据有界读取、namespace逃逸拒绝。
- standalone宿主HTTP集成1项通过：真实F02 C01 schema的明确合成材料导入、重复importId幂等、重启加载相同版本与图、缺试跑拒绝激活。
- `@crewon/domain` / `@crewon/application` / `@crewon/store` 类型检查通过；`@crewon/control-api` / `@crewon/control-client` 在首轮接线后通过；后续Zod/generation变化需重新检查。
- `pnpm crewon:boundary:check` 通过。

这些测试使用真实本地SQLite/Turn/HTTP，不等于真实模型或浏览器完成。标为real的review准入反例中，`SkillRunEvidencePort`显式为测试夹具；生产证据适配器只识别已持久化的受支持provider调用。C01样本明确为synthetic，未录制真实浏览器。尚未执行真实新日期/文件交付、C05授权操作、真实模型GUI、端到端断线恢复。

## S3 模型、复用与联合宿主

- `3b6900e61`：Zod 4.4.3 strict schema、JSON Schema 与 js-yaml 4.3.0 frontmatter 验证；普通/中文换行引号两组旧 v1 Markdown 与 SHA-256 固定快照保持一致。domain 新测试 9/9，上层行为 18/18。
- `eb5b211e3`：真实 Turn 的草稿生成、SQLite 持久化/恢复、HTTP 与宿主；generation 初轮集成 10/10、generation 与既有 Skill 路由组合 10/10（新增 generation 路由 2 项）。首次及崩溃恢复应用需要存档和当前证据均 real；测试中的 real 来源标记仍是明确 port fixture。
- F04 完整 UI/Run 映射合入 `1f55dd7ed`；F05 授权组件合入 `cd9b70320`；F04 实际 standalone + SQLite + 正式 AgentVersion release 的 2 项测试合入 `12b9a7a50` 并通过。激活前置 Skill 为明确 synthetic seed，未伪装真实模型试跑。
- `pnpm --filter './packages/**' -r typecheck` 全部通过。领域 143/143、应用 177/177、ControlClient 104/104、Store 486 通过 / 94 跳过；Control API 194 通过 / 5 跳过；Worker 437 通过 / 46 跳过。跳过项保持测试本身的外部环境要求，未改断言或删除用例。
- `pnpm --filter './packages/**' -r test` 在旧 `package-boundaries.test.ts` 三项失败处中止。F03 新增的 Zod/js-yaml 与 C01 recording 子路径已按架构决策精确补录；其余 23 条 import 均逐项核对存在于基线 `79bf09d88`，另 agent-kernel/domain、store/contracts 的 manifest 依赖也存在于基线。未为消除基线失败扩大允许范围。之后单独跑上述受影响包确认。
- `pnpm format` 已通过；最终新增文档与脚本的收口检查见 S5。

浏览器 UI 证据是独立契约样本，使用系统 Chrome 实际渲染 1440×900、1100×600、390×844 三尺寸，均无横向溢出、无 pageerror。截图为 full-page，保存在 [artifacts](./artifacts/checks.json)。页面明确标注“UI 契约样本 · 不代表真实模型或浏览器执行验收”。这验证布局，不证明真实身份、工具执行、模型输出或交付。

工具硬边界与 collect 权威消息归属的复查发现：`executionIntent:none` 不是零工具保证；追加用户消息也不能作为原 Run 输出无效的依据。修复及恶意工具请求、追加消息回归证据见 S4。

## S4 真实模型与硬边界

- `505cbeeb9`：发布所有 Skill 共用的固定生成角色，同一模型、tools=[]、maxToolRounds=0；普通正工具预算不变。Worker 首次请求、动态 goal/plan、pending/reconcile/approval 恢复均在执行前拒绝工具；providerAgent/0 拒绝。零工具仍可文字完成。Resolver 与硬边界 9/9，发布配置/脚本 8/8；AgentVersion 6/6、generation SQLite 12/12、既有 Worker 相关 142 通过 / 1 PostgreSQL 跳过。
- 相同提交修复 collect：只接受 outputRef 指向且由 message.completed 绑定同一 Run 的 assistant 消息。生成时追加用户消息不再误判合法结果；旧 pending 命令重新核对当前生成路由。
- 最终 backend 全量：Control API 205 通过 / 5 跳过，Worker 445 通过 / 46 跳过；fixture来源与F04事务fence联合 14/14。边界入口检查通过。
- F04 `ff84a9e80` 合入 `c74186e12`，SQLite 保存/执行事务共用完整 Skill/版本行校验，另连接在准入后禁用、摘要列/revision列损坏均无新 Run/任务。`9d241ee3d` 合入 `b0e033b4d` 修复手动日程日期预检使用真实创建时间，避免 sentinel 误入业务参数。

2026-09-14 的真实模型检查通过授权进程内读取现有凭据，调用 https://api.aicuican.com/v1 的 gpt-5.5；不修改原配置，不复制凭据文件，不接原用户数据库。两次调用均采用独立临时 SQLite、Session 和正式 release，均为一次实际 provider 调用、0 工具执行记录。

第一次 Run `01a09e2a-a558-759a-97ad-436aa2698a6e` 的生成/采用成功，但 HTTP 手工样本未携带来源降级标记，验收脚本在来源断言失败。该记录和原输出保持不变，见 [初次部分证据](./artifacts/real-generation-initial-partial.json)。随后增加严格的 `provenance:"contract-fixture"`：只可降级、持久化、幂等重试不能去掉标记，标记过的样本不能确认真实试跑或激活。HTTP+来源相关 21/21，明确 real 证据下的样本激活反例也通过。

修正后的独立 Run `01a09e2c-dbec-7728-9c8c-1eebd2e41108` 实际完成：正式固定角色 tools=[]、maxToolRounds=0；provider 调用1；工具 receipt0；collect real/candidate；用户确认接口采用为 revision2；来源 contract-fixture 保留且未激活。见 [真实生成证据](./artifacts/real-generation.json) 和 [可复现脚本](./fixtures/run-real-generation.mjs)。脚本必须显式给出已授权 env 路径，不自行发现私密配置。

另一个独立 Control 进程重开同一隔离库，读取、collect、apply重放全部200，仍为同一Run/revision2/source；modelCalls 1→1，未启动Worker。见 [重启恢复证据](./artifacts/real-generation-restart.json) 和 [恢复脚本](./fixtures/verify-generation-restart.mjs)。这只验证完成后的HTTP恢复，不冒称中断provider流或浏览器断线恢复。

合成 C01 上的真实模型生成不能替代 F02 对真实浏览器的采集，也不证明 F05动作或F01交付。后续联合验收需要真实F02录制（业务网站可以是合成站点）、不同日期/输入、产物核对与用户确认；这一项仍待联合任务完成。

## S5 主界面与真实 F02 导入

- `ee79f42c8`：App 使用原认证 ControlClient 注册 typed 录制交接；ACK 不明重试保留 body/key；身份切换取消旧监听/请求；成功后打开资源库并按返回 skillId 定位。模型候选需要明确采用；版本/试跑/确认/禁用已接 HTTP。F04 公共日程入口无目标时创建真实Thread，幂等重试，成功才打开表单。F05 浏览器授权在真实Thread准备后、Run启动前呈现，无scope不默授，可显式使用普通逐次确认。
- `pnpm --filter @crewon/ui lint` 通过；`pnpm --filter @crewon/ui exec vitest run src/components/skill src/lib/skill/demonstratedSkillClient.test.ts CommandWorkspace BrowserExecutionAuthorization` 为21文件/176项全通过；`pnpm --filter @crewon/ui build` 通过。包含 F02 hook 六项、主界面/库定位两项以及既有 CommandWorkspace 回归。
- 追加浏览器授权阶段三尺寸截图 [browser-gate-checks](./artifacts/browser-gate-checks.json)，无横向溢出/pageerror。仍为明确契约样本，不是实际bridge或模型GUI。
- F02 `45b8ee383` 后续capture防护合入 `797fc0ee4`。

真实F02 source导入检查消费其已提交 `aa81fecb0` 的原始 export/evidence：recordingId `rec-43652ed4-46ea-466d-af61-2983259a1158`，revision24，15steps、13evidence（3 PNG），digest `sha256:4e3b4cb1fdb476fe52281cb85feae9d2caf933f08f0441e93bf04f2c136b7a15`。通过真实认证HTTP导入、C01/附件SHA校验、SQLite关闭重开、逐字节读回；来源保留 recording，生成prompt5674 bytes，未修改URL或摘要。业务页面是合成站点，但采集是F02真实capture链；本次仅导入/持久化，不宣称模型或浏览器执行。见 [实际来源导入证据](./artifacts/f02-source-import.json) 与 [复跑脚本](./fixtures/verify-f02-import.mjs)。

F01同一DeliveryService validator与完整F05 bridge由共同集成任务接线；F03暴露的deliveryTargets只接受权威校验，缺失时仍拒绝带target调用。新日期/输入、真实browser动作/XLSX交付、人工确认激活与流中断恢复的整体E05继续在联合任务验收，未在此标完成。

最终后端复跑：所有 packages typecheck 通过；Application177/177、AgentVersion6/6、Store488通过/95跳过；当前 generation/SQLite host/日程 fence 四文件14/14。

`16e5c67be` 修复复查发现的身份边界：切换 ControlClient 立即重建 Skill 库、面板与生成状态；异步创建Thread后、提交前和回执回调前核对当前客户端与组件生命周期，旧身份不能继续提交或覆盖新页面。新增9项行为反例，其中7项先复现失败；修复后相同窄命令21文件/185项全通过，UI lint/build 与 `git diff --check` 通过。此项为 React/happy-dom 行为验证，不作为真实模型或浏览器闭环证据。

收口运行 `pnpm format`，并显式检查 F03 文档、脚本与 JSON 的 Prettier 格式；均通过。分支完成 F03 独立实现与证据交付，T08 保留为协调任务与 F05 的联合验收待办。
