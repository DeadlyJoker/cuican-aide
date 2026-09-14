# SDD 任务协调记录

协调任务：规划超越 WorkBuddy 的功能（01a09dd1-80a8-71f2-8c64-27726d731025）。

## 状态

- 用户新增开源复用要求已同步 F01–F05，并纳入 [SDD 总纲](README.md) 与 [复用选型记录](reuse-decisions.md)。各 owner 复核已有通用自研代码、补选型依据与真实兼容验证，必要时保留测试后替换通用实现。
- 2026-09-14：产品范围和四个 feature 边界已写入 [SDD 总纲](README.md)。
- 公共基线：`79bf09d88b06fe1d823e5b6107843e13b34f0f4e`，分支 `codex/sdd-baseline-20260914`，worktree `/Users/cheneywang/project/wqc/cuican-aide-sdd-baseline-20260914`。
- 基线从原工作区连续两次读取内容摘要一致后复制并提交，仅在隔离 worktree 建立提交，未暂存或提交原目录的改动。包含 2,619 份仓库文件，不复制被 Git 忽略的运行时数据、依赖目录或环境文件。其后原工作区的新修改需要独立集成。
- 四个 feature 的新任务均已启动，各自在独立 worktree 中读取基线并开展 SDD。创建或启动不代表 feature 完成。
- 接线检查发现浏览器缺少 Agent 执行动作端口，已新增 F05 独立配套任务，补齐既定示教执行路径。边界见 [browser-execution-gap.md](browser-execution-gap.md)。
- 原工作区还有“分析内存泄露与磁盘积累”任务进行中。本批任务在隔离基线与独立 worktree 开发，不覆盖其工作。
- 已建立 `codex/sdd-integration-20260914` 独立集成树。已合入 F04 消费端/事务内准入、F03 无工具生成生命周期与 UI/双向宿主、F01 表格引擎/传输/交付 UI、F02 完整录制宿主/实际 source 证据；根补齐 C03 同一服务的目标权限验证。分批合并后行为检查通过。F05 实际动作接线和完整 E04/E05 联合验收继续，见 [集成记录](integration-progress.md)。

## 开发任务

| Feature | 任务标题                           | 任务 ID                                | Worktree                                              |
| ------- | ---------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| F01     | SDD：交付基础与表格成果闭环        | `01a09def-20b0-74b2-8bb7-92f65e039e4b` | `/Users/cheneywang/.codex/worktrees/7171/cuican-aide` |
| F02     | SDD：浏览器示教录制与证据导出      | `01a09def-208b-7391-a745-c2f05e57e4a2` | `/Users/cheneywang/.codex/worktrees/1a8a/cuican-aide` |
| F03     | SDD：示教 Skill 生成试跑与版本管理 | `01a09def-208b-7391-a745-c303214bd0e2` | `/Users/cheneywang/.codex/worktrees/ba8b/cuican-aide` |
| F04     | SDD：Skill 接入现有日程安排        | `01a09def-20ad-7c20-bec2-02636e40f050` | `/Users/cheneywang/.codex/worktrees/281f/cuican-aide` |
| F05     | SDD：浏览器执行桥与示教闭环        | `01a09dfe-3f9f-7de2-bd4d-6d63498c788f` | `/Users/cheneywang/.codex/worktrees/4876/cuican-aide` |

首轮职责：F02 向 F03 提供 C01；F03 向 F04 提供 C02；F01 向 F03/F04 提供 C03；F04 自行维护 C04 兼容。各任务的 S1 设计提交后主动向协调任务汇报，继续无依赖实现；契约差异在这里确认后再集成。

补充职责：F05 拥有 C05 浏览器执行端口，与 F02 协商单浏览器会话接入及录制/执行互斥，向 F03 提供实际已注册工具，与 F01 接通真实下载文件入口。F03 负责录制导出到认证 Skill 导入的用户路径和有界证据读取。

已可引用的独立契约提交：C03 `9afef710f`（F01，domain 类型/parser，类型检查与反例通过）；C01 `2fca252d6`（F02，contracts 类型/parser/合成样本，9 个测试与类型检查通过）。这表示契约可供依赖任务集成，不表示真实文件或浏览器闭环已通过验收。F05 已合入公共基线，在 `codex/f05-browser-execution` 调查和设计。

F04 S2 已报告：合入 C02 `2e819073f`/`7ff5ec543`，v1 固定快照、周期日期、Store 独立重算、前置 v0 过滤和 UI 正在实现，窄测试已通过部分基线；Postgres 用例有跳过，真实宿主尚未接通。协调复核发现 BFF 请求头白名单缺少新能力头，已交 F04 补最小接线及穿透验证；同时补齐分页设计与实际实现的一致性、每日程准入失败可见状态。

F03 S2 已报告 `bd1e2f309`（持久生命周期与原子 Run 绑定）、`d6c894f06`（认证接口与 standalone 宿主）；已接入 F04 核心，真实模型草稿/UI/录制交接及浏览器授权仍在实现。F05 经协调允许追加独立认证只读 Run 浏览器上下文投影，原因是旧 RunView 和 F03 Skill 投影不含所需 workspace 事实；不改变旧 RunView，不将 run:read 当成执行授权，实际动作仍验证 grant、runtime 命令与 Skill 准入，并关注 cancelRequested。

## 状态报告格式

每次报告：feature ID；当前 SDD 阶段；spec/design/tasks 路径；已完成的需求编号；契约变更与 owner；分支和提交；检查及证据；真实阻塞；下一步。仅 SDD 文档完成、只通过模拟或依赖尚未接线时不得标记 feature 完成。

## 首轮设计检查

| Feature | S1 提交     | 协调检查结论                                                                                                 | 实际进度                                  |
| ------- | ----------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| F01     | `98cda5b10` | C03 thread 托管集合与固定版本引用方向确认；核实基线 domain 仅允许 text/plain，限制表格引擎范围和模型片段预算 | S1 已提交，独立实现进行中                 |
| F02     | `46c7e2fca` | C01 本地来源声明方向确认；owner 已补安全 routeTemplate、role/accessibleName 与实际局部 PNG 画面              | S1 已提交，评审修订已响应，独立实现进行中 |
| F03     | `9bf42c106` | C02 固定版本与唯一准入端口确认；补 RunRoute 绑定、可重算上下文及用户激活门槛分层                             | S1 已提交，独立实现进行中                 |
| F04     | `09b51b49c` | 复用现有 scheduler/receipt 与 v0 兼容方向确认；补旧客户端处理 v1 和 occurrence 日期参数                      | S1 已提交，兼容基线与独立实现进行中       |
| F05     | `5e23e2fe9` | ToolRuntime→本机认证桥→F02同view路线确认；补普通状态观察、连续执行的任务授权和文件上限一致性                 | S1 已提交，评审修订与独立实现进行中       |

### 已裁定的接口原则

- C01 本地录制来源声明不授予远程身份权限，F03 经认证导入后绑定真实 owner/workspace；录制保留授权页中可复用的脱敏导航信息和目标语义。敏感值由运行时参数代替，不能一概删除普通页面路径、控件名称和任务相关文字；几何定位图仅作辅助，不代替实际关键画面。
- C03 的 tenant/space/thread 来自已授权对象，传入引用仍逐次鉴权；sourceRunId 为 null 只代表受授权人工保存，不冒称 Agent 执行。
- C02 不为每个 Skill 新建 AgentVersion 或运行引擎；与 F04 共同确定实际路由绑定与持久指令重算协议。为保证生成阶段只能产出草稿，允许通过现有正式 release/binding 发布一个固定、无工具的生成角色；所有 Skill 共用该角色，不能只靠 prompt 或 executionIntent 声明禁止执行。F01/F05 工具及动态 goal/plan 工具也必须被排除。
- C04 将已批准的日期规则按既有 occurrence 解析，单次调用使用固定具体参数；不因创建时与运行时日期不同判为 Skill 被篡改。
- C04 新客户端通过 `x-crewon-automation-version: 1` 显式声明能力后读取 v0/v1；旧列表只返回 v0，在分页前过滤并覆盖混合分页行为；旧客户端直接访问 v1 返回沿用现有错误封装的升级提示。旧 v0 序列化和执行摘要保持不变。
- C05 已确认独立 `crewon_browser_act_scoped`，宿主强制验证显式 grant，保留原 act 的逐次审批。授权 epoch 与导航 generation 分开，具体输入绑定本次权威 Skill 参数，F03/F04 分别提供真实 Run/日程 invocation 映射；详见浏览器补充边界，仍待实现验收。
- 产品发布的多样本/异常验收与每个用户 Skill 的启用流程分开，避免把示教变成复杂测试配置。
- 全链路共同材料见 [integration-acceptance.md](integration-acceptance.md)，是尚未执行的合成验收标准。
