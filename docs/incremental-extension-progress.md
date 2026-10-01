# 增量扩展子系统实施进度

目标：按 [实施方案](./incremental-extension-subsystem-plan.md) 推进。状态：进行中，不能据此认为完整插件子系统已经交付。

当前用户要求优先跑通调用流程，再细化插件产品形态。第一个真实场景已确定为用户提供的 ComfyUI Krea2 文生图工作流，生成全部由外部服务完成。

## 2026-10-01：实际发布工厂与显式组合入口

ComfyUI 已接入现有 AgentVersion 发布及运行工厂。`compileComfyAgentVersion` 从明确的 crewonKernel 版本编译独立插件版本，保留模型、已有工具及资源要求，追加确切插件指导和两个工具；拒绝替换默认版本、工具名冲突及 providerAgent。运行绑定新增可选 `extensionConfigPath`，没有该字段的旧配置保持原形状及原 materialization 摘要。

配置文件冻结完整配置修订和审批要求，工厂根据实际宿主登记校验实现摘要，并在真正构造工具 owner 后记录不可变装配证明。配置、审批、工具或指导变化均不能冒用已发布版本。读取发布元数据与构造工厂使用同一份复制后的绑定清单；新增绑定、跨租户绑定或覆盖默认 Agent 的文件漂移会被拒绝。

实现身份来自实际 Worker 生产源码、递归工作区依赖、锁文件和构建输入的指纹。现有桌面打包流程把同一指纹注入各入口，并写入每个 bundle 的独立文件摘要；加载进程核对磁盘与加载时身份，源码或构建文件变化后拒绝把新字节当作旧运行环境。该指纹只证明代码身份，不授予权限。保守指纹也覆盖宿主依赖变化：升级后须发布新配置/版本；旧任务需保留匹配的旧构建才能恢复。历史构建保留及升级切换流程仍待实现，本轮不声称已解决跨宿主升级的旧任务执行。

Control 通过新的有界、鉴权 loopback 协议取得目录和实时 readiness。Worker 从当前可信身份再次核对完整 principal/actor/tenant/space 与权限，再通过执行 Run 的同一个 resolver 实际 acquire/release。只有配置、实现、部署、路由和真实工具装配全部匹配才返回 ready；持久化部署记录或工具名称不能单独证明可运行。HTTP 关闭与超时保留物理在途工作，直到归还实际运行时租约。

Worker 的 SQLite/PostgreSQL 组合接受显式 `extensionRuntime`，在拥有数据库后等待插件迁移并构造工厂；两个子 Store 复用父连接和生命周期，父关闭后拒绝调用。Control 新增异步 `createStandaloneControlApiWithExtensions`，PostgreSQL 的异步组合增加可选 Worker 接线，复用现有配置及任务用例。旧同步 Control 组合与默认聊天继续保持原行为；没有显式接线时插件路由仍为 404。

### 验证范围

- 新组合集成使用真实 Control HTTP 任务入口、完整配置保存/启停、实际 AgentVersion 发布、真实 Worker 工厂和 SQLite 存储。外部受理后在工具回执前中断，停用插件、关闭并重建 Worker 和 Control，再恢复同一 Run，取得两个工具完成事件与图片 URL 流式输出。通过真正的 Control SSE 和 `Last-Event-ID` 两次重连，取得相同的旧游标后事件；生成 POST 总数为 1。默认 Agent 的摘要、指导和工具保持原状。
- 该组合测试的模型是本地 HTTP SSE 夹具，ComfyUI/DNS 是确定性夹具；实际发布和装配身份均由本次宿主代码生成，没有合成 readiness 或实现摘要。此前真实模型/ComfyUI 图片证据继续保留，本轮未重复调用真实生成。
- 全量回归：Worker 857 通过、195 项环境相关跳过；Control 253 通过、9 项环境相关跳过；Contracts 115 通过；AgentVersion 16 通过，均为 0 失败。另在真实 PostgreSQL 18 执行新增双库组合 22 项与 Control 组合 9 项，全部通过；这补齐了本轮新增 PostgreSQL 路径，未将其他既有环境跳过计作验收。
- 真实 PostgreSQL 的 Store 全量：1,167 通过、0 失败，1 个环境提示占位跳过，实际数据库行为测试均执行。临时服务全程仅开放 Unix socket，检查后已停止并清除数据。
- 五个模块类型检查、TypeScript 边界入口及 `pnpm format` 通过。桌面 stage 的 4 项测试和全部 7 个实际生产入口打包/语法检查通过，共同源码指纹与每入口文件摘要已写入 sidecar。日志为 `output/extensions/checks/extension-composition-*.log`、`extension-private-host-tests.log`、`extension-store-full-postgres.log` 和 `extension-control-composition-postgres.log`。

**下一步：** 组合入口已经接通；进程启动参数、现有发布 CLI 与桌面/服务器启动协调尚未启用这组入口。生产多用户后台身份查询仍需可信宿主端口，不能从 actorId 推造 principal。继续补正式启动接线，再连接 BFF、客户端及最小界面；短剧工作台的详细产品形态保持后置。

## 2026-10-01：用户输入原子准入与可选任务 HTTP 入口

新增 `ExtensionTaskApplicationService`，先检查插件执行/查询、线程写入和 Run 创建权限，再通过现有 Turn 用例准备用户消息、模型历史和 Run。SQLite 与 PostgreSQL 将这些记录、插件绑定、outbox、队列、Turn 回执及插件任务回执放入同一次事务。绑定写入失败时全部回滚；并发重复请求和数据库重开后只返回原任务。

生成任务使用当前启用配置，绑定摘要覆盖真正提交给 Agent 的用户内容。查询任务必须证明原 Run 的当前读取权限和 operation 归属，沿用原配置及执行版本；插件停用后仍可查询，撤销拒绝新查询。激活状态在提交事务中再次比较 revision，配置切换与准入竞争不会产生半个任务。已有活跃 Thread Goal 的线程拒绝插件准入，保留原目标、历史及 Run。

Control 新增可选 `POST /api/v1/extensions/:pluginId/tasks`，严格区分生成输入与原任务查询，要求 `Idempotency-Key`，复用当前身份及错误边界。请求不能指定租户、空间、实现摘要、Agent 或配置修订；响应只返回已提交的线程、消息、Run 与配置修订标识。后续结果继续经现有 Run/事件接口读取。默认组合没有安装这些服务，插件路由仍返回 404；正式生产装配尚未完成。

任务回执新增 `crewon.extension-turn-admission.v0` 标识，复用现有表。旧 Run-only 回执仍可由旧读取入口重放；Turn 入口拒绝将缺少用户消息的旧回执当作新任务成功。没有批量迁移历史，也没有改变默认 Agent。

### 验证范围

- 双库存储专项覆盖并发、重开、绑定失败完整回滚、用户内容摘要与历史一致、停用/撤销后的回执重放及旧回执兼容。
- Application 双库行为测试覆盖权限、配置竞争、原任务读取权限、目标保护、客户端身份注入和幂等冲突。HTTP 覆盖鉴权、未知参数、输入上限、同空间归属、并发重放、查询归属，以及 outbox 唤醒失败不撤销已提交任务。
- 原有 Kernel / Worker 恢复集成现在通过上述正式任务用例提交真实用户消息与绑定，验证受理后中断、停用、数据库重开、流式输出和游标续读；生成 POST 仍为 1。模型与 HTTP 为确定性夹具，宿主部署为合成数据，不据此声称生产组合或真实发布装配已验收。
- 全量回归：Contracts 110 通过；Application 191 通过；Control 236 通过、8 项环境相关跳过；Worker 808 通过、184 项环境相关跳过。真实 PostgreSQL 18 的 Store 全量为 1,161 通过、0 失败，另跳过 1 个“缺少数据库环境”的提示占位测试，实际数据库行为测试已执行。临时数据库仅开放 Unix socket，结束后已停止并清理。
- 五个模块的类型检查、TypeScript 边界入口及仓库格式检查通过，日志在 `output/extensions/checks/extension-turn-*.log`。真实模型与 ComfyUI 的此前证据继续保留，本轮没有再次生成图片。

**下一步：** 将经过验证的宿主实现身份、精确配置和模型路由纳入发布/运行装配，并实际安装配置及任务服务。随后连接 BFF、客户端和最小界面；短剧工作台的详细产品设计仍后置。

## 2026-10-01：按持久化绑定执行 ComfyUI 工具

新增 `BoundComfyToolRuntime`，供一个不可变 AgentVersion 的多个 Run 共用。每次执行都从 Store 读取本 Run 的插件绑定、配置修订和真实 Run 身份；运行时拒绝不同配置、实现登记、执行路由或没有插件绑定的任务。配置改版后，已准入任务继续使用原地址和配置。

通过 `CurrentExtensionExecutionAuthorization` 从宿主重新解析当前身份，检查本 Run 执行权和插件权限；关联查询还检查原 Run 的读取权。实际 HTTP 请求在 DNS 校验后、传输前再次检查当前权限、插件启用/撤销状态和提交租约。普通停用不阻止既有提交的恢复与获授权查询；撤销也阻止返回工具缓存结果。

另起的查询 Run 只能读取持久化关联的原 operation；它不能重新提交生图，也不能用任意 operation ID 查询供应商。共享运行时关闭会终止所属请求并等待在途工作退出。生图 manifest 和工具目录已增加到源码，模型描述明确说明关联查询的范围。

### 验证范围

- 新增 10 项 Worker 适配器行为测试，使用真实 SQLite 配置、激活、Run 绑定和外部回执，覆盖并发隔离、配置变更、重新打开、停用/撤销、查询归属、DNS 期间撤权及运行时关闭。
- 新增 4 项 Application 当前身份/权限测试，覆盖身份变更、原任务读取权限、无效来源、取消和异步期间的调用方修改。
- 新增现有 Kernel / Worker 的集成测试：受理后、工具回执写入前中断；停用插件后关闭并重新打开 Run Store，重建运行时并恢复。取得 2 条工具完成事件、图片 URL 的流式输出、持久化助手消息，以及旧游标之后的事件；生成 POST 总数为 1。
- 上述新增测试的模型、DNS 和 ComfyUI 传输为确定性夹具，部署标识为合成测试数据。它们验证共享运行时的绑定与恢复行为，不代替真实发布工厂和正式入口验收；此前真实模型与 ComfyUI 证据仍见后文，本轮未重复生成图片。
- Application 全量：191 通过；Worker 全量：808 通过、184 项环境相关跳过、0 失败。两者类型检查、TypeScript 边界入口检查与 `pnpm format` 通过。日志为 `output/extensions/checks/bound-*.log`。

用户新增的短剧参考已整理在[短剧工作台参考结论](./short-drama-workbench-reference.md)。当前 Krea2 仍只承诺文生图；参考图、视频及配音接入留待实际 API 验证。产品形态后置的顺序保持不变。

**下一步仍需正式装配。** 当前新增运行时尚未挂入生产组合入口：需将宿主构建的真实实现标识、模型路由和配置绑定纳入 AgentVersion 发布/装配。用户输入、Run 与插件绑定的一次事务准入现已完成，见上节；配置到结果的实际组合入口、通用 BFF/客户端和 UI 的完整流程尚未完成，目标继续进行中。

## 2026-09-30：真实 ComfyUI 链路验证

在隔离分支 `codex/incremental-extensions` 开发，原工作目录的未提交改动保持原状。

### 已验证事实

- 用户提供 `T01-Krea2文生图超强写实质感 (2).json` 及无鉴权的 HTTPS ComfyUI 服务地址。
- 只读检查返回 ComfyUI `0.37.0`；工作流所需的 11 个节点类型可用，UNet、CLIP、VAE 和 LoRA 模型名称均存在于该服务。
- 实际运行：提示词 → `POST /prompt` → `GET /history/:id` / `GET /queue` → `GET /view`，成功取得 PNG 图片并验证文件签名、尺寸和摘要。
- 单张、1MP 档、原工作流的 8 steps 与固定 seed；测试内容为窗边陶瓷茶壶。返回图片为 768×1368、1,313,769 bytes。
- 再运行诊断脚本的 `--resume`，通过已有任务编号取得同一张图片，没有走提交分支。

| 证据                        | 值                                                                 |
| --------------------------- | ------------------------------------------------------------------ |
| 外部任务编号                | `da7b2922-e9a1-4dda-9020-528bfbe197d0`                             |
| 图片 SHA-256                | `6a508e9a7344c05f80ded26cda9987155f3de82fade55ad45f924d1d9131bd6d` |
| 输入工作流规范 JSON SHA-256 | `3dfa5d5cade0e1dddf1e4d200dc9d0f6c7162960e18569fe39ec6539ead83b66` |
| 本地回执                    | `output/extensions/comfyui/first-image/receipt.json`               |
| 本地图片                    | `output/extensions/comfyui/first-image/image-1.png`                |
| 只读检查记录                | `output/extensions/comfyui/preflight.json`                         |

生成数据保存在当前工作树的 `output/extensions/`，不纳入 Git。上面的实际调用验证了外部 API 链路；尚未证明 CrewON 产品内的 Agent、审批和 Run 恢复链路已接通。

### 工作流与协议边界

- 当前工作流的 KSampler 直接引用节点 `55`，节点 `87` 的 LoRA 未接入输出路径。此次保持原连线，没有自动修改出图行为。
- 提交工具完成只能表示外部服务已受理，不能表示图片已经生成。观察状态分别表达 queued、running、succeeded、failed 和 unknownOutcome。
- ComfyUI 接受任务关联 ID 不代表支持持久化幂等提交。官方 [server.py](https://github.com/Comfy-Org/ComfyUI/blob/master/server.py) 的提交路径会入队；因此适配器不自动重发 POST。历史与队列均找不到任务时保留未知结果，不推断为可再次提交。
- 当前不暴露全局 interrupt 或清空队列，避免影响同一服务上的其他任务。定向取消需独立验证后再接入。

## 已增加的代码

| 模块                                                                      | 实施范围                                                                                                    |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [ComfyApi](../apps/runtime-worker/src/extensions/comfyui-api.ts)          | 提交、按任务查询、真实完成判断和受限结果引用；HTTP、授权和持久化通过宿主边界注入                            |
| [诊断脚本](../scripts/comfyui-flow-smoke.mjs)                             | 有界真实调用、请求前保存提交状态、任务回执、显式 resume、PNG 读取；不是生产网络适配器或后台调度器           |
| [插件声明](../packages/domain/src/extension-manifest.ts)                  | 严格版本与字段、有界指令、凭据槽声明、工具策略、输入与配置校验；复用已有 Workflow 的有界 schema 子集        |
| [静态注册表](../apps/runtime-worker/src/extensions/extension-registry.ts) | 注册失败隔离、重复版本/工具冲突拒绝、精确实现摘要匹配、保留多个历史版本；只注册元数据，不代表获授权或可执行 |

复用的 Workflow schema 是现有宿主内部子集，不直接当作标准 JSON Schema 传给模型；实际装配工具时仍需转换和契约验证。首个提交没有增加公共 HTTP 路由、持久化业务表或修改旧 Agent 版本；后续持久化进展见下节。

新增行为测试覆盖：声明与输入越界、越权字段、mutation 不得声明安全重放、静态注册冲突、适配器缺失/变更、已提交与已完成区分、提交响应丢失不重发、未知任务、错误结果和图片路径校验。测试中的 `example.video` 是合成夹具，不是对用户暴露的可用服务。

### 本轮验证结果

- Domain 全量测试：145 通过。
- Runtime Worker 全量测试：783 通过、184 项环境相关测试跳过、0 失败；不据此声称跳过的数据库/环境路径已经验收。
- Domain、Runtime Worker 类型检查通过；`pnpm crewon:boundary:check`、`pnpm format`、新增代码格式和本地文档链接检查通过。
- 包依赖边界测试：8 通过、4 失败。已在原工作目录复现同样 4 项失败，相关文件对 HEAD 无修改；原因是既有 `process-lifecycle` 包及其 Control/Worker/Device 使用尚未登记到边界清单。本轮未放宽检查或修改这些既有文件。基线复现日志位于 `output/extensions/checks/baseline-package-boundaries.log`。

## 阶段状态与下一步

| 阶段                 | 当前证据                                                                              |
| -------------------- | ------------------------------------------------------------------------------------- |
| E0 接入验证          | 真实 ComfyUI API 与独立发布的 crewonKernel 模型路径已通过；产品准入接线见 E2          |
| E1 契约与注册        | 声明、静态登记与真实 Worker readiness 已实现；正式进程启动启用待接线                  |
| E2 配置与绑定        | 双库原子准入、实际发布工厂与显式 Control/Worker 组合已验证；发布 CLI 和启动协调待接线 |
| E3 Agent / Tool 闭环 | 实际模型经 CrewON Worker 提交、进程重启恢复并返回图片已验证；生产插件配置装配仍待 E2  |
| E4 UI / E5 第二业务  | 尚未实施；遵循用户指示，产品形态细化放在调用链路完成之后                              |

继续顺序：在已验证的真实 Agent 生图链路上，增加配置与启停、Run 原子绑定、按 AgentVersion 的插件装配及正式任务准入。这个过程保留现有聊天和团队路径。

## 2026-09-30：配置修订与 Run 原子绑定存储

新增配置、激活和 Run 绑定的版本化记录及 SQLite / PostgreSQL 实现，作为正式接入的存储基础，尚未提供产品入口。

- 配置修订不可变，摘要覆盖空间、插件版本、实现摘要、非秘密参数和凭据引用；保存使用预期 revision 与按 actor 隔离的幂等回执。参数上限 16KiB，复制并冻结记录，拒绝未知字段、未知版本、重复凭据槽及摘要不一致。
- 激活状态独立于配置保存。启用要求已发布的 AgentVersion 与部署记录匹配，声明的执行主体必须为 crewonKernel；存储核对内容摘要、materialization 摘要、authority、policy 和 workspace。此检查只证明持久化身份，不能代替宿主对真实运行时、工具实现与权限的检查。
- 插件绑定、既有 Run 事件/快照、outbox、执行队列及请求回执在同一事务内提交。通过注入绑定写入失败，验证所有任务写入完整回滚，清除故障后同一请求可正常提交。
- 重复请求在配置切换、停用或撤销后仍返回原有 Run，不创建新任务；新请求必须使用当前启用的配置。幂等结果读取本身不授予再次访问外部 API 的权限。
- 独立查询 Run 必须关联同空间、同插件的原生成 Run、绑定摘要及已保存 operation；停用后可沿原配置准入查询，撤销后拒绝新查询。实际外部调用时的实时撤销校验仍需接入 Worker。
- 新迁移由宿主显式调用，带独立 schema 版本，不要求旧任务批量迁移；普通 Run 创建不产生插件绑定。SQLite 复用现有同步提交事务，PostgreSQL 复用现有 Run 提交及队列事务。

### 检查与剩余边界

- Domain / Application / Store 全量测试分别为 **149 / 187 / 763 通过，0 失败**；Store 另有 171 项环境相关测试跳过。
- 在实际 SQLite 文件与临时 PostgreSQL 18 中执行新增配置/绑定契约和既有外部回执专项：**35 通过，0 跳过**。覆盖独立连接并发、配置冲突、重复请求、回滚、重新打开、旧任务兼容和跨空间隔离。临时 PostgreSQL 只开放 Unix socket，运行后停止并清理。
- 三个包及 Runtime Worker 的类型检查通过；Worker 的 ComfyUI 与注册表专项 **27 通过，0 跳过**，包含现有流式执行和中断恢复集成。TypeScript 边界入口及仓库格式检查通过。日志位于 `output/extensions/checks/extension-config-regression.log`、`extension-storage-sqlite-postgres.log` 和 `extension-worker-regression.log`。

下一步是 Application 授权与配置用例、可信目录/运行时就绪检查、AgentVersion 装配，以及 Worker 从持久化 Run 绑定选择工具实例。当前存储接口仅供已授权的宿主用例调用，不是公共 API；不能单凭保存激活记录就声称插件已经可用。产品页面和详细产品形态仍未展开。

## 2026-09-30：配置授权用例与 Control 协议

本阶段把前述存储接入独立的 Application 配置用例，并提供显式装配时才注册的 Control 路由。

- 新增 `extension:read/configure/activate/run/query` 权限动作与空间内插件资源。生产权限适配器仍向既有策略服务逐次请求判定，独立模式仅接受当前配置的 actor / principal / tenant / space；没有新增隐式授权或匿名入口。
- 配置保存从可信目录取得声明和实现摘要，验证插件配置 schema、参数大小、凭据槽与引用，再交给宿主做适配器特定校验。请求不能自带 tenant、space、实现摘要、执行路由或秘密值字段。
- 启用必须显式选择 AgentVersion，校验配置绑定的精确实现和必需凭据，向宿主请求就绪判定，再由存储事务复核部署身份。不会修改默认模型、发布新 Agent 或启动 Run。停用/撤销不依赖失效的插件目录和运行时继续在线。
- actor 与命令在首次异步调用前复制。所有读写和幂等重放先检查当前权限；配置和激活的重复请求可从持久化回执返回。旧启用请求在随后停用后重试，只返回原回执，不执行重新启用。
- 新增 OpenAPI、生成类型、严格请求解析和 `GET/PUT /api/v1/extensions/:pluginId/configuration`、`GET/PUT /api/v1/extensions/:pluginId/activation`。PUT 要求 `Idempotency-Key`；配置 GET 可选择精确 revision，省略时返回最新保存修订。保存与激活分别表达。
- Control 组合入口增加可选配置服务；没有显式注入时不注册上述路由。既有入口的默认行为有独立回归验证。

### 当前验证范围

- Contracts **109 通过**，Application **187 通过**，Store **770 通过 / 178 环境相关跳过**，Control API **233 通过 / 8 环境相关跳过**，均为 0 失败；随后新增的默认不注册路由用例单独通过。
- 实际 SQLite 与临时 PostgreSQL 的配置授权、配置/Run 绑定、外部回执专项共 **49 通过，0 跳过**。HTTP 层覆盖认证、空间隔离、未知字段、幂等冲突、查询 revision、激活及撤权后拒绝重放。
- Contracts / Application / Store / Control / Worker 类型检查通过，OpenAPI 生成检查与既有协议兼容检查通过。Worker 注册表与跨进程恢复集成 **6 通过**；本轮未再次发起生图。
- 检查日志为 `output/extensions/checks/extension-control-regression.log`、`extension-control-typecheck.log` 和 `extension-control-postgres.log`。

**仍未完成生产插件启用。** 这些用例与 HTTP 测试使用明确标注的合成宿主就绪判定，证明授权和事务语义，不证明真实运行时可以装配。下一步需要实现 ComfyUI 的生产宿主校验、精确配置对应的 AgentVersion 装配、Worker 按 Run 绑定解析与实时撤销检查，再接插件任务创建和实际输入。BFF / 客户端与产品界面尚未接入，产品形态继续后置。

## 2026-09-30：持久化 Tool 执行与 Worker 恢复

遵循“先跑通流程”的要求，新增实现集中在执行链，未增加插件页面或重构原聊天、团队入口。

- `ExternalOperationStore` 以 tenant、Run 和不可变绑定摘要隔离回执，保存执行身份、输入摘要、提交前关联 ID、服务端任务 ID、观察状态及有界结果引用；记录带 `crewon.external-operation.v0` 版本。
- SQLite 和 PostgreSQL 均通过唯一键争抢首次提交权。已有回执不重新获得提交权，执行身份变更拒绝复用；状态更新使用 revision 比较，终态不得回退。未知版本或损坏回执拒绝读取。
- `ComfyToolRuntime` 使用宿主的 ActionIntent、执行租约和审批凭据校验。提交前持久化；响应丢失和重启只查询，永不自动重发 POST。工具受理回执与生图完成状态分开表达，最终结果仅在 observe 成功时返回。
- 两个工具分别接收提示词和本 Run 的 operationId；模型不能提供服务地址、任意工作流、其他 Run 或文件路径。复用用户的 Krea2 图，固定本阶段验证用的单张、1MP、8 steps，保留原 LoRA 未连接状态。
- `ProductionComfyHttp` 复用现有 DNS 审核与地址固定传输，只访问宿主配置的 HTTPS 服务和明确允许的端点，限制响应体与超时，不跟随重定向，不注入凭据，不开放全局取消。
- 新迁移只在插件宿主显式调用时创建附加表；尚未接入通用 Control 配置、AgentVersion 发布和 Run 创建事务，不能据此认为已有产品入口已启用该能力。

### 当前证据

1. 真实服务：通过生产 HTTP 适配器查询首张图片任务，取得 `succeeded` 和 1 个图片引用。记录在 `output/extensions/comfyui/production-http-observation.json`；本轮没有再次生成图片。
2. 存储：在临时 PostgreSQL 18 和实际 SQLite 文件上运行同一套行为测试，覆盖独立连接争抢、重新打开、过期 revision、租户/Run/配置隔离、身份冲突及有界结果。临时数据库只开放 Unix socket，测试结束后已停止并清理。
3. 工具：覆盖提交前已有数据库回执、响应丢失、并发查询与受理回写竞争、服务端返回不同任务 ID、审批、租约过期、未知历史和终态缓存；POST 次数由测试明确断言。
4. 现有 CrewON 执行链：`comfyui-worker.integration.test.ts` 使用真实 Kernel、RuntimeWorker、SQLite 队列、ActionIntent 和 Tool 回执，在外部受理后/Worker 回执提交前模拟进程退出，再重新打开数据库恢复。最终两次工具调用完成、一次外部提交、流式文本携带图片 URL，事件游标续读也能取得结果。**该测试的模型和 ComfyUI HTTP 为确定性夹具，不是已完成真实模型的端到端验收。**

### 本阶段检查

- Application 回归：187 通过；Store 回归：751 通过、160 项环境相关测试跳过。
- Runtime Worker 完整回归：797 通过、184 项环境相关测试跳过、0 失败。
- 新增存储专项在真实 SQLite/PostgreSQL 上：13 通过、0 跳过；没有把全库测试中跳过的 PostgreSQL 项目算作已验证。
- Application、Store、Runtime Worker 类型检查、TypeScript 边界入口检查和仓库格式检查通过。详细日志保留在 `output/extensions/checks/`。
- 既有包依赖边界清单的 4 项基线失败仍见前节，本阶段未改动该清单。

### 接下来的接线

当前 Comfy 工具实例按 Run 隔离，而生产 AgentVersion runtime 由多个 Run 共享。应先增加宿主从持久化 Run 绑定解析插件版本/配置的适配层，再将其纳入 AgentVersion materialization 摘要和组合工厂；不能直接把一个 Run 的工具实例挂给所有 Run。

剩余工作包括配置快照、激活权限、Run 创建时的原子关联、注册声明与可执行适配器一致性、实际模型路由调用，以及跨模型流恢复的验证。产品形态细化仍放在真实流程验收之后。

## 2026-09-30：真实模型经 CrewON Worker 生图与跨进程恢复

实际执行了“用户描述 → 真实模型工具调用 → CrewON Worker → ComfyUI → 图片链接返回”。配置模型为 `gpt-5.5`，复用已有开发环境的 Responses 路由与凭据配置；没有复制或输出密钥，也没有修改原开发数据库和默认 Agent。

### 执行证据

- 在 `output/extensions/comfyui/real-agent/control.sqlite` 中通过现有发布流程发布并激活独立 AgentVersion，然后通过现有 Thread / Run 用例创建任务。
- 第一个 Node 进程中，真实模型自行请求 `crewon_comfyui_krea2__submit`。ComfyUI 受理并保存外部回执后，通过 Worker 的测试钩子在宿主工具回执提交前中断本次执行。
- 第二个 Node 进程用 `--resume` 打开同一数据库、同一 Run 和同一 AgentVersion，恢复既有提交回执。真实模型继续调用 `crewon_comfyui_krea2__observe`，取得成功结果，并以 Markdown 图片链接结束任务。
- HTTP 调用审计累计只有 **1 个 POST /prompt**。最终 Run 为 completed，外部操作为 succeeded；没有重新生成。
- 图片 GET 返回 200，PNG 签名、768×1368 尺寸和 SHA-256 已验证，目视内容为窗边木桌上的白色陶瓷茶壶与绿叶，符合输入描述。
- 以第一个进程结束时的事件游标 6 续读，取得后续 121 条事件，最后序号 127，包含恢复后的工具结果和模型流式输出。

| 项目                    | 值                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------- |
| Run                     | `5e7d22c9-4629-4984-a37a-5c6b36a4e2a4`                                              |
| AgentVersion            | `comfy-agent-5e7d22c9-4629-4984-a37a-5c6b36a4e2a4`                                  |
| AgentVersion 内容摘要   | `sha256:b39e429cac880bc260ae0ef723ed084afc21ea094aa3faedde0cbb96ca617588`           |
| 外部任务                | `0e46520c-fe54-1065-e1a9-cdab63f63bd1`                                              |
| 图片 bytes              | `1267632`                                                                           |
| 图片 SHA-256            | `0878b563bf13885745d89ad1e46841ecda8bb321db2131771940cc23a5a149fe`                  |
| 首次/恢复证据           | `output/extensions/comfyui/real-agent/first-evidence.json`、`resumed-evidence.json` |
| 请求审计/文件与事件核验 | 同目录 `comfy-http.jsonl`、`verification.json`                                      |
| 图片                    | 同目录 `image-1.png`                                                                |

### 复现真实 Agent 流程

新增 [真实 Agent 联调脚本](../scripts/comfyui-agent-flow-smoke.mjs)，使用 Node.js 24，调用现有发布、线程、Run、Worker 和 DirectResponsesTransport。它不是第二套 Agent 引擎，也不是正式的插件配置/任务准入 API。

```sh
node --experimental-strip-types scripts/comfyui-agent-flow-smoke.mjs \
  --output-dir output/extensions/comfyui/new-agent-run \
  --base-url 'https://YOUR-COMFYUI-SERVICE/' \
  --model-endpoint 'https://YOUR-MODEL-PROVIDER/v1/responses' \
  --model-id 'YOUR-MODEL' \
  --api-key-environment CREWON_MODEL_API_KEY \
  --env-file '/absolute/path/to/your/local.env' \
  --pause-after-submit \
  --prompt '请生成一张写实照片：清晨窗边木桌上的白色陶瓷茶壶和绿叶。'

node --experimental-strip-types scripts/comfyui-agent-flow-smoke.mjs \
  --output-dir output/extensions/comfyui/new-agent-run \
  --env-file '/absolute/path/to/your/local.env' --resume
```

默认 request profile 为现有开发服务所用的 `responsesLite`；标准 Responses 服务可显式传 `--request-profile standard`。首次运行目录中已有快照或数据库时拒绝再次创建；resume 拒绝传入新提示词或替换模型/服务参数，并验证保存快照和适配器源码摘要。对应的重复启动、参数替换和实现漂移防护已实测拒绝，HTTP 审计没有新增请求。完成后的第三次 resume 返回已保存结果；127 条事件、消息及外部回执均未改变，未产生新的生成提交，证据为同目录 `replay-evidence.json`。

**完成范围：真实调用流程与跨进程恢复已经验证。** 当前仍在隔离的诊断环境：固定一个 Run 的宿主绑定写在诊断快照中，尚未替代 E2 要求的工作空间配置、启停/撤销、Run 原子绑定和生产组合工厂，也尚未从产品界面发起。完整目标保持进行中。

### 复现诊断

使用 Node.js 24 和 pnpm 10。首次调用必须显式提供服务地址、工作流和输出目录；脚本不读取隐式凭据，不重试生成请求。

```sh
node --experimental-strip-types scripts/comfyui-flow-smoke.mjs \
  --base-url 'https://YOUR-COMFYUI-SERVICE/' \
  --workflow '/absolute/path/to/workflow.json' \
  --output-dir output/extensions/comfyui/new-run \
  --prompt 'A photorealistic ceramic teapot beside a sunlit window.' \
  --megapixels 1

node --experimental-strip-types scripts/comfyui-flow-smoke.mjs \
  --output-dir output/extensions/comfyui/new-run --resume
```

诊断使用的是本次 Krea2 工作流的固定输入节点，不是支持任意 ComfyUI 工作流的导入器。输出目录已有回执时拒绝重新提交，必须显式 resume 或为新任务选择新目录。
