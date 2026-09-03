# CrewON 任务详细信息 Popover 设计方案

状态：P0a 已落地，P0b / P1 / P2 待续  
适用范围：CrewON 主对话任务页  
设计基线：`artifacts/desktop-command-home-scene-update`

## 1. 目标与不可变边界

任务详情用于回答：任务是否需要用户处理、运行在哪里、产生了什么变更、有哪些子智能体和后台进程、使用了哪些来源、当前可执行哪些操作。

以下边界不可变：

- 它是标题栏触发的独立浮动 Popover。
- 它不是最右侧工作台，不属于工作台内部。
- 它不是右侧 Drawer，也不是主布局第三列。
- 它不进入 `.workspace` grid，不改变主对话、消息和 Composer 的宽度或居中位置。
- 它与最右侧工作台拥有独立 open、focus、scroll、loading 和 error state。
- 两者可以同时打开；最右侧工作台打开时，Popover 只向左避让。
- 详情入口只提供摘要与操作入口；完整 Diff、终端、来源和日志继续在最右侧工作台展示。

## 2. 视觉与定位

沿用现有 CrewON 中性工作台语言：单一外层表面、细边框、弱分隔线、现有圆角与浮层阴影；不增加多层卡片、强渐变和高饱和装饰。状态色只用于状态点、增删行数、权限与危险操作。

| 项目       | 规格                                |
| ---------- | ----------------------------------- |
| 默认宽度   | 360px；范围 336–400px               |
| 顶部       | 标题栏下方 8px，约 `48–52px`        |
| 右侧间距   | 12–16px                             |
| 工作台间距 | 12–16px                             |
| 最大高度   | `calc(100dvh - 64px)`               |
| 行高       | 32–36px，多行按需增长               |
| 层级       | 高于主对话，低于批准/危险操作 Modal |

生产路由采用主区网格锚点，不手工复制工作台宽度：

```css
.task-detail-popover {
  position: absolute;
  grid-column: 1 / 2;
  grid-row: 1 / 2;
  justify-self: end;
  right: 12px;
}
```

最右工作台是网格第二列；它展开时第一列自然收窄，Popover 随第一列右边界左移。这样无需读取或近似工作台宽度。打开详情前后，消息列表、消息最大宽度和 Composer 的 `boundingRect` 必须一致；不得再使用 Inspector reserve padding。

## 3. DOM 与组件边界

建议 DOM：

```html
<button
  aria-label="任务详细信息"
  aria-expanded="true"
  aria-controls="task-detail-popover"
  aria-haspopup="dialog"
></button>

<section
  id="task-detail-popover"
  role="dialog"
  aria-modal="false"
  aria-labelledby="task-detail-title"
>
  <header>...</header>
  <div data-task-detail-scroll>...</div>
</section>
```

建议组件与职责：

```text
TaskDetailToggle              触发、aria、open state
TaskDetailPopover             定位、焦点、滚动、整体状态
  TaskDetailHeader            状态与主操作
  TaskBlockerSection          批准、用户输入、异常
  TaskEnvironmentSection      变更、cwd、Git、权限摘要
  TaskSubagentsSection        子智能体摘要
  TaskProcessesSection        后台进程摘要
  TaskSourcesSection          输入来源与运行引用
  TaskDeliverySection         审阅与安全操作入口
useTaskDetailSnapshot         数据归一、请求、通知与刷新
```

展示组件不直接遍历全部 ThreadItem 或调用 app-server。模型层对历史只遍历一次；大列表有硬上限，“查看全部”进入最右侧工作台。Thread 切换使用 AbortController 或 generation，防止旧请求覆盖新任务。

## 4. 信息架构

按以下顺序渲染：

1. Header。
2. 用户待处理事项，仅条件展示。
3. 环境信息。
4. 子智能体，仅存在或团队模式时展示。
5. 后台进程，仅存在、运行中空态或读取失败时展示。
6. 来源，仅存在或读取失败时展示。
7. 交付与危险操作，仅存在可用动作时展示。
8. 更多技术信息，默认折叠。

### 4.1 Header 与待处理事项

Header 显示“任务详细信息”、统一状态、更新时间/刷新/离线标签、条件主操作和更多菜单。

主操作映射：运行中显示“停止”；等待批准显示“处理”；等待输入显示“回答”；未加载显示“加载任务”；完成或无任务不显示主操作。失败/中断仅在后端提供可靠能力时显示“重试/继续”。

待处理事项优先级为：系统错误 > 等待批准 > 等待输入 > 外部动作确认。卡片只显示清洗后的原因和处理入口，不展示原始 RPC 方法、JSON 或堆栈。

### 4.2 环境信息

默认显示：

- 变更：显示当前工作区、当前分支相对 `HEAD` 的 staged、unstaged、untracked 汇总，排除 `.crewon/**` 产品内部元数据；不回退为任务记录。点击在工作台打开完整变更。
- 工作区：basename 为主，完整路径只在有权限时通过 Tooltip/复制提供。
- Git：分支或 detached HEAD；非 Git 与读取失败必须区分。
- 任务变更：不放入环境信息；与 Todo 共用 Composer 上方状态胶囊，无 Todo 时独立显示。

任务变更与环境变更是两套不可互换的数据：环境变更是打开面板时读取的当前工作区相对 `HEAD` 的实时总量；任务变更覆盖当前 Thread 的完整有效任务历史，而不是仅取最新 Turn。服务端按 rollback 后仍有效的 Model History 聚合终态 Turn Run 中已持久记录的编辑操作，文件按 path 去重，增删行按已完成操作累计；当前活动 Run 再通过连续 SSE 独立叠加。Run 终态后以包含该 Run 的新服务端快照原子替换基线，避免重连或刷新重复计数。

Control 仅消费 `tool.completed.workspaceChanges` 结构化元数据，不解析工具输出。活动 Run 出现序列断裂、未完成 mutation 或投影溢出，服务端读取遇到历史缺口、旧事件缺少元数据、并发 revision 变化或统计越界时，都必须 fail closed：不展示精确胶囊，也不回退到环境总量。Thread 切换和 rollback 使用 generation、Thread revision 与 Model History sequence 三重栅栏，旧请求不得覆盖新任务。

更多技术信息可显示模型、权限配置、批准策略、Sandbox、协作模式、HEAD、upstream、ahead/behind，但必须来自当前任务权威设置。无任务时显示“选择任务后查看详情”，不得用 server URL 冒充工作区；默认环境显示“默认执行环境”。

### 4.3 子智能体

摘要格式：`2 运行 · 13 完成 · 1 异常`，并显示受限头像堆叠。

- 按唯一 receiverThreadId 聚合，同一 Agent 的 send/wait/resume 不重复计数。
- 展开项显示昵称/短 ID、角色、状态、最近消息、模型和更新时间。
- 点击“打开子任务”进入对应任务，不新建主页对话模型。
- P0 只有协作 Item 时标记“最近记录”，不能冒充实时状态。
- 普通单 Agent 无子任务时隐藏分区；团队尚未派发可显示紧凑空态。

### 4.4 后台进程

每行显示命令短名、运行状态、cwd basename，以及可用的 PID/CPU/RSS。点击行在最右工作台打开终端。

终止流程：点击“终止” → 行内确认 → 仅目标行 pending → 成功刷新。进程已自然结束按幂等成功处理；403 时不展示命令和路径。完成任务且列表为空时隐藏分区。

### 4.5 来源

来源分为：

- 输入来源：image/localImage、文件或文件夹 Mention、Skill、其他结构化 Mention。
- 运行引用：Web Search、MCP resource URI、有明确 URI 的工具结果。

默认最多 3 项，按规范化 path/URL/URI 去重，超出显示“查看全部 N”。图片用受控缩略图；data URL 不进入文本/Tooltip；外部路径只在授权后预览；MCP URI 只显示安全摘要。点击来源在最右工作台预览，Popover 保持打开并左移。

### 4.6 操作分级

- 只读：查看变更、审阅、日志、来源、复制 ID/路径。
- 运行控制：停止 Turn、终止进程、后端明确支持的重试/继续。
- 写入/外部动作：提交、推送、发布、共享发送。

首版写入和外部动作必须 draft-only。提交与推送是两个独立入口；确认界面展示 cwd、文件、分支、remote 与预期动作。Push 必须走网络/外部动作批准。无真实能力的按钮应省略或显示明确禁用原因，不能通过自然语言 Turn 模拟正式 mutation。

## 5. 统一任务状态

用户状态：未选择、未加载、运行中、等待批准、等待输入、已完成、已中断、已失败；“离线快照”是附加可信度，不替换业务状态。

决议顺序：

```text
无 thread                                      -> 未选择
thread.systemError 或 latestTurn.failed        -> 已失败
activeFlags.waitingOnApproval                   -> 等待批准
activeFlags.waitingOnUserInput                  -> 等待输入
thread.active                                   -> 运行中
latestTurn.interrupted                          -> 已中断
thread.notLoaded                                -> 未加载
thread.idle 且 latestTurn.completed             -> 已完成
其他                                            -> 未加载/无运行记录
```

协议枚举必须本地化，不直接显示 `active`、`idle`。离线时保留最后业务状态并附加“离线 · 上次更新于…”，同时停止运行态动画，避免伪装实时。

## 6. 交互与数据状态机

### 6.1 可见性

```text
closed --toggle--> open
open --toggle--> closed
open --Escape且最后激活--> closed并归还焦点
open --thread changed--> open + hydrate(newThread)
open --workbench changed--> open + reposition
```

- 普通对话点击不关闭 Popover，保证可与最右工作台并行操作。
- 打开/关闭任何一方都不写入另一方 open state。
- 任务切换时保持面板打开，原位加载新任务。
- 路由离开 Chat 时隐藏；返回后恢复用户显式偏好。
- Escape 只关闭最后激活的浮层，不能一次关闭左栏、详情和工作台。

### 6.2 数据状态

面板：`empty | hydrating | ready | partialError | offline | forbidden | fatalError`。  
分区：`idle | loading | ready | refreshing | empty | error | forbidden | stale`。

点击后立即打开稳定 Shell；先同步显示内存 Thread，再并行加载附加分区。刷新保留旧值并显示“刷新中”，不闪回全骨架。单个分区失败不得清空其他内容。

通知用于增量更新 Thread/Turn/Item；后台进程仅面板可见时刷新：运行中 2–5 秒、空闲约 10 秒，隐藏或页面失焦时停止/降频。不得因每个消息 delta 重新请求全部详情。

## 7. 数据来源与可信度

可信度分为：当前 RPC/notification 的`实时权威`、`thread/read` 结构化历史的`持久权威`、确定性聚合的`客户端派生`、旧或不完整接口的`兼容数据`、只有最后事件状态的`最近记录`，以及断线时的`离线快照`。

可能被误解为实时事实的值必须在 UI 暴露标签或 Tooltip。每个字段模型应携带 `provenance`、`updatedAt` 和 availability，不能用 `null` 同时表示加载中、空、无权限和失败。

| 字段               | P0 来源                                               | 可信度/限制                           |
| ------------------ | ----------------------------------------------------- | ------------------------------------- |
| cwd、GitInfo、Turn | `thread/read(includeTurns)`                           | 持久权威；GitInfo 不是实时 Git 状态   |
| Thread 状态        | status notification + Thread                          | 实时权威；断线后降级                  |
| 任务变更           | Thread task-change ledger + 活动 Run 连续 SSE overlay | 终态持久权威 + 活动实时权威；缺口隐藏 |
| Control Git 摘要   | Global `/sandbox/git-summary`                         | 当前工作区；只传元数据，不传 Diff     |
| 远端差异           | `gitDiffToRemote`                                     | 兼容数据；相对最近远端 SHA            |
| 子智能体           | `collabAgentToolCall`、`subAgentActivity`             | 最近记录；缺少权威 child list         |
| 后台进程           | `thread/backgroundTerminals/list`                     | 实时权威；无通知时轮询                |
| 输入来源           | `UserMessage.content`                                 | 持久权威                              |
| 运行引用           | webSearch、mcpAppResourceUri                          | 持久权威；需过滤敏感 URI              |
| 权限/模型          | 当前 settings notification                            | 冷启动不完整，不可推测                |

账号和“已加载线程数”属于全局环境，不进入任务详情主信息架构。

## 8. 加载、错误与权限

- 首次加载：稳定 Shell + 分区级骨架，核心数据可用后立即展示。
- 无任务：只显示选择任务提示，不渲染虚假环境行。
- 非 Git：显示“非 Git 工作区”，隐藏 Git 操作；读取失败显示“无法读取 · 重试”。
- 局部失败：行内原因和重试；保留其他分区及最后成功值。
- 断线：保留快照、标注可能过期、禁用 mutation；重连后原位 refreshing。
- 403：显示“无权查看/操作”，隐藏敏感路径、命令、URI 和凭据；只有真实流程存在时才显示“请求权限”。
- Mutation：只锁定对应按钮/行；失败恢复可用状态并保留上下文。

权限必须区分详情读取、来源读取、运行控制、草稿创建和外部动作批准。历史任务权限必须来自后端权威 settings，不能从当前 Composer 选项推测。

## 9. 响应式与无障碍

| viewport     | 行为                                                                 |
| ------------ | -------------------------------------------------------------------- |
| `>=1120px`   | 360–400px 浮层；工作台打开时锚定其左侧                               |
| `860–1119px` | 336–360px，允许覆盖更多对话但不覆盖工作台                            |
| `720–859px`  | `min(360px, 100vw - 24px)`；两浮层状态仍独立                         |
| `<720px`     | `top:52px; inset-inline:8px; bottom:8px` 的视口内浮层，不转为 Drawer |
| 低高度       | Header sticky、内容独立滚动、技术信息默认折叠                        |

使用 safe-area inset。窄屏两浮层不互相改状态，最后激活者层级更高；被覆盖的 Surface 保持 open state，但必须设置 `inert + aria-hidden` 并暂停全局快捷键。原生 Browser viewport 只设为不可见并保留生命周期，不能因切换而销毁页面状态。切换入口通过 `aria-controls` 指向目标 Surface，切换后恢复该 Surface 的最近焦点，失效时回退到关闭按钮。当两者重叠时，主列与工作台交界处提供始终可达的紧凑切换按钮，手机宽度则吸附视口左侧中部。

无障碍要求：

- Trigger 使用真实 button、`aria-expanded/controls/haspopup`。
- 面板为有名称的非模态 dialog，`aria-modal=false`，不做全局焦点陷阱。
- 键盘打开时聚焦首个操作；鼠标打开可保留 Trigger 焦点。
- Escape 由路由 DOM 冒泡层关闭最后激活浮层并归还焦点；Modal/Portal、Launcher、浏览器菜单等内层瞬态界面先消费 Escape，不能一次连带关闭工作台或详情；输入法组合态与 `keyCode 229` 不参与面板关闭。
- 折叠和行内确认使用正确 `aria-expanded` 与焦点回退。
- 关键状态用节制的 `aria-live`；CPU/RSS 高频变化不播报。
- 增删行同时保留 `+/-` 文本，不能只依赖红绿。
- 支持 reduced-motion；状态点可轻微光晕但不持续强闪烁。

## 10. 安全约束

- Popover 只加载有界摘要，不加载无限历史、完整日志或文件正文。
- 子智能体、来源、进程有硬上限和“查看全部”。
- 历史路径不自动授予读取权限；外部路径和符号链接由后端权限层判定。
- 后台命令只显示白名单 executable 与无敏感语义的 subcommand；协议提供安全摘要前，不回显任意参数、Header、URL、Token、密码或环境变量，历史命令不能直接重放。
- data URL、敏感 MCP URI、服务端堆栈不能通过正文、复制或 Tooltip 泄露。
- 停止 Turn 是紧急控制，可单击执行但必须立即反馈。
- 终止具体进程需要对象级确认。
- Commit、Push、Publish、Shared Write 和 destructive action 首版均为 draft-only。
- Mutation 必须结构化，带 idempotencyKey、expectedHeadSha 和批准/冲突结果；拒绝不能自动升级权限。

## 11. P0 / P1 / P2

### P0：现有协议可信首版

- 解耦任务详情与最右工作台状态，移除对消息和 Composer 的 reserve。
- 完成浮层定位、响应式、焦点和最后激活 Escape。
- 新增统一状态、分区状态和 provenance 展示模型。
- 从 Thread 投影环境、去重任务变更、来源和“最近记录”子智能体。
- 接入现有后台进程 list/terminate/clean。
- 详细查看复用最右工作台，保持 Popover 打开并左移。
- 停止任务和终止进程可用；提交/推送仅草稿或明确不可用。
- 补状态决议、投影、样式快照、共存、进程、来源、键盘测试。

实施拆分：

- P0a（本次已落地）：独立浮层与标题栏入口、第一列网格锚定、Thread 环境/任务变更/最近子智能体/来源投影、metadata-only 当前工作区分支与全量变更汇总、Control 工作区命令的有界持久化任务变更账本、rollback 后有效的完整 Thread 终态账本与活动 Run 实时叠加、任务变更 Todo/独立胶囊、离线快照语义、现有 Legacy 后台进程查询与两步终止、Control 能力缺失的中性不可用状态、authority 切换同步清理旧进程与 Git 请求、白名单命令摘要、停止当前 Turn 的对象级 pending、工作台审阅/终端入口、路由 DOM 冒泡层 Escape 与内层菜单/Modal/IME 优先消费、窄屏双向切换、后层 `inert + aria-hidden`、原生 Browser 暂停不销毁、焦点/敏感数据/快照与真实浏览器回归。
- P0b（下一阶段）：待处理事项区、来源“查看全部”与安全预览、停止/终止结果通知、真实页面交互自动化固化。
- P1/P2：按下述远端工作区只读协议和结构化写入方案推进；当前 Git 摘要明确声明为当前工作区，不冒充历史任务绑定快照，也不伪造 Control 进程或提交/推送能力。

P0 完成条件：所有值有真实来源或明确“兼容数据/最近记录”，无装饰性假数据。

### P1：只读权威协议

- 新增 v2 分页 child list，按 parentThreadId 返回 nickname、role、status、model、updatedAt、lastMessage，避免全局列表和 N+1 read。
- 远端设备新增绑定感知的 v2 Git status read：从授权执行环境解析 `workspaceBindingId`，返回 HEAD、branch/detached、upstream、ahead/behind、工作树文件与统计；不得复用本机全局摘要接口。
- 新增历史可读 Thread Settings：activePermissionProfile、approvalPolicy、sandbox、model、collaborationMode。
- 新增后台进程更新通知，或保留有界轮询并记录限制。
- 补 app-server schema、分页、父子权限、Git 边界和冷启动恢复集成测试。

P1 完成条件：实时面板不依赖兼容接口或前端猜测。

### P2：写入、交付与审计

- Commit 与 Push 使用两个结构化 mutation，包含 threadId、cwd、范围、expectedHeadSha、idempotencyKey；Push 明确 remote/branch。
- 首次点击生成影响范围草稿，用户确认后再进入文件、网络或外部动作批准。
- 返回 drafted/requiresApproval/committed/conflict 等可判定结果。
- 审计记录发起人、批准人、权限、文件、remote、预期/实际 HEAD、结果和时间；完整审计在最右工作台查看。

P2 完成条件：写入可追溯、可幂等重试，双击和网络重试不重复执行。

## 12. 已知协议缺口

| 缺口                      | P0 策略                   | P1/P2 修复                   |
| ------------------------- | ------------------------- | ---------------------------- |
| 无父线程过滤 child list   | 协作 Item 标“最近记录”    | 分页权威 child list          |
| 无远端绑定感知 Git status | 本机/单租户当前工作区摘要 | 远端绑定感知 Git status read |
| 历史 settings 不完整      | 不推测，未知即不可用      | settings read                |
| 进程无更新通知            | 可见时有界轮询            | updated notification         |
| 无 commit/push mutation   | draft-only                | 结构化 mutation + approval   |
| Web/MCP 引用元数据不完整  | 安全摘要，不虚构链接      | 返回安全 display metadata    |

新 app-server API 必须进入 v2，遵循项目命名、camelCase、分页、schema 和行为测试规范。

## 13. 验收矩阵

| 维度      | 必测场景                                               | 通过标准                                        |
| --------- | ------------------------------------------------------ | ----------------------------------------------- |
| 布局      | 详情/工作台分别及同时开关                              | 两者独立；详情左移；主对话与 Composer rect 不变 |
| 状态      | 未选、未加载、运行、批准、输入、完成、中断、失败、离线 | 标题、色调、主操作和卡点正确                    |
| 子智能体  | 0/1/3/20+、重复事件、异常/notFound                     | 唯一 Agent 聚合；有界展示；可信度正确           |
| 进程      | 0/1/20、自然结束、终止失败、403                        | 对象级 pending；幂等反馈；无泄露                |
| 来源      | 0/1/3/20+、重复、长名、data URL、敏感 URI              | 去重、有界、安全预览                            |
| 变更      | 0、多文件、同文件多事件、rename/delete、大 Diff        | path 去重；任务/远端语义分离                    |
| 网络      | 首开离线、刷新失败、局部超时、重连、旧请求晚到         | 保留快照；分区隔离；旧请求不覆盖                |
| 权限      | 只读、运行控制拒绝、来源 403、外部动作待批准           | 按能力显示；敏感数据隐藏                        |
| 响应式    | 1440/1120/860/720/390px、600px 高、200% 缩放           | 无裁切；独立滚动；不转第三列/Drawer             |
| 主题/动效 | 浅色、深色、reduced-motion                             | 对比度合格；无强闪烁                            |
| 无障碍    | 键盘、焦点回退、最后激活 Escape、Screen Reader         | 无焦点丢失；播报一次；不只依赖颜色              |
| 安全      | 外部路径、敏感命令、Push 双击、HEAD 冲突               | 不泄露、不重复 mutation、冲突阻断               |

UI 变化必须有对应 snapshot；协议变化必须有 app-server 行为集成测试。交付前需在真实 CrewON 页面检查浅/深色、低高度、窄屏、双浮层共存和真实任务状态变化。

## 14. Definition of Done

1. 任务详情是独立浮动 Popover，不是右栏、Drawer 或第三列。
2. 打开前后主对话、消息和 Composer 几何尺寸不变。
3. 它与最右工作台可同时打开，状态互不影响，工作台打开时正确左移。
4. 统一任务状态经过决议和本地化，停止按钮在运行中可用。
5. 环境、子智能体、后台进程和来源均为真实数据或带明确可信度。
6. 当前分支总变更与本任务记录变更分离；无任务、非 Git、离线和 403 行为明确。
7. 每个分区独立加载、错误和刷新；旧请求不覆盖新任务。
8. 焦点、Escape、键盘、播报、窄屏和低高度通过验收。
9. 停止/终止有对象和反馈；写入/外部动作遵循 draft-only、批准、幂等和审计。
10. P0 UI 测试与快照通过；P1/P2 协议具备 schema、行为和安全测试。
