# 逆向 ChatGPT 与 CrewON 逐项对照及改造顺序

## 结论先行

CrewON 应参考的是 **清晰的执行归属、按会话绑定的状态、集中处理的流式收敛，以及共享的工具宿主机制**。目前最值得减少的复杂度是：固定关闭后仍参与生产装配的旧链路、renderer 中的团队/工作流推进、细粒度读取引起的多次快照协调，以及重复的工具调用生命周期实现。

应保留的是：前端显示暂态、顺序消费、明确的完成边界、断线恢复与轮询兜底、执行身份、审批、租约、幂等、未知副作用恢复、持久权威与派生视图的分离。逆向 ChatGPT 同样包含复杂的客户端状态、后台 watcher、快照合并和多层数据库，不能用它作为删除这些机制的依据。

改造主线：**退出旧生产装配 → 合并会话读模型与收敛责任 → 后端持久调度团队/工作流 → 收敛工具生命周期及资源隔离 → 自主子 agent。** 包入口和类型检查减负可随前两步推进，不应先做大规模目录重组、引入新运行时或重写整个 Store。

本轮没有修改业务代码、配置或用户数据，没有提交新的代码变更。

## 对比对象与证据边界

- ChatGPT：本机逆向目录 `/Users/cheneywang/project/解包/chatgpt-analysis-26.1007.71326`，对应安装包 **26.1007.71326 / build 20398**。包含普通 ChatGPT 云会话、ChatGPT Work 与 Codex 任务路径；三者不能混为一个协议。
- CrewON：当前 `24d7a6343100bc98f53594765fec923a4bf53271`，已包含上一轮工作池唤醒、立即补位与工具有序提前提交。
- 可以比较 ChatGPT renderer、Electron 宿主、AppHost/IPC、可见的本地工具及部分任务协议与 CrewON 的 renderer、Electron/BFF、Control API、Worker、工具宿主。
- **不能比较 ChatGPT 云端后端完整架构、源码规模、数据库实现或真实并发能力**：这些未被恢复。Rust/Swift 任务引擎只有协议、结构及少量汇编证据，不能据字符串推导完整实现。
- 下文“已知”指发布代码静态可见，不是本机 ChatGPT 的实际权限、流量或速度实测。“借鉴建议”是对 CrewON 的设计判断，不冒充逆向结论。

主要证据：`reports/chat-and-ui-flow.md`、`reports/desktop-host-and-app-server.md`、`reports/resources-and-tool-runtime.md`、`reports/storage-and-trust-boundaries.md`、`native-analysis/README.md`。另外核对了若干 readable JS 的实际函数，详见后面的证据索引。

## 逐项对照

| 项目                     | ChatGPT 逆向证据                                                                                                        | CrewON 当前实现                                                                                          | 必要复杂度与精简结论                                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. UI 与执行责任         | 工具卡按结构化 item 渲染；真实本地调用经宿主和执行服务。Codex 有 app-server 与本地引擎                                  | 普通 Run 在 Worker 执行，但 Team/Workflow 的 fork、阶段推进、等待、汇总仍在 renderer                     | **迁移责任**：UI 继续负责输入、展示和审批；业务执行推进进入持久调度。不能说 ChatGPT renderer 完全没有业务逻辑                                                                                   |
| 2. 不同协议的适配        | 普通 ChatGPT 用 conversation 消息树，原生 Codex 用 thread/turn/item；Work 还可挂本地 executor                           | 当前工作台明确选 Control，旧 AppServer 连接却固定关闭后仍保留装配，Control 结果又适配旧 Thread/Turn 类型 | **适配有必要，失效兼容可减**：退役当前入口不再使用的旧装配，逐步建立 CrewON 自己的展示模型；不能从 ChatGPT 多协议推导“我们必须统一成一个协议”                                                   |
| 3. 会话权威和暂态        | message consumer 捕获 account/user/stream ownership；历史快照合并保留更新的本地增量                                     | Run/Thread 持久权威、前端 streaming preview、草稿、工具投影、页面选择各有状态                            | **大部分保留**：一个权威状态可以有多个派生视图。应明确每类状态的所有者及可重建关系，减少同一业务状态被多层独立解释；不应把所有 Map/cache 合并成一个全局对象                                     |
| 4. 历史读取              | ChatGPT 有按 turn 分页和分支历史快照；Codex 的 thread/read 可携带 turns                                                 | transcript window、active Run、逐个历史 Run、台账、plan 分开读，外层多次核对 head                        | **可精简**：提供有界一致的会话视图或批量 Run 摘要，减少前端请求扇出和快照竞态。这是借鉴接口形状，不代表 ChatGPT 服务端只做一次 DB 查询                                                          |
| 5. 流式消费和显示        | 异步 delta 顺序 Promise 队列、按 channel 编码；submission 批处理，resume 重放有约 50ms flush                            | SSE sequence、工具和文本投影、带预算的 streaming preview、最终 canonical 同步                            | **保留顺序与预算，集中收敛**：沿现有协议共用处理机制。无需复制它的 delta 编码，也不能把重放 50ms 当成所有文本都应延迟显示；当前 CrewON 已无打字延迟队列                                         |
| 6. 完成语义              | HTTP 接受、DONE、main/message complete、Work final 和渲染 flush 不同；完成等待 pending decoder                          | accepted Run、模型完成、工具提交、Run terminal、前端最终同步不同；上轮工具结果已按完成前缀及时提交       | **必须保留分层**：集中实现最终收敛，不能把 HTTP 200、EOF 或一条 terminal 通知等同于显示完成。当前有序结果流和 started-call join 应保留                                                          |
| 7. 断线与轮询            | 活动流存在时不盲开恢复；无活动流时查询 stream_status，COMPLETE 拉历史；有界 resume、后台 watcher 和 terminal polling    | SSE 重连、sequence catch-up、共享状态查询 monitor、低频兜底；Team/Workflow 另有等待循环                  | **必要机制，减少重复所有者**：不能全删轮询。CrewON monitor 已合并并发查询，首次约 500ms 后，健康流下后续等待约 15–30 秒，不是所有路径都高频轮询。后续共享状态监视与持久调度，减少各业务独立循环 |
| 8. 请求调度与公平性      | 宿主 clientRequestQueue 接收 coalesce/priority/timeout/expiresAt；stdio 每片最多 200 项或 8ms 后让出事件循环            | 生产 Worker 默认 2 lane，当前已有合并提示、setImmediate 补位、持久扫描兜底                               | **保留有界并发与让出执行**：必要时补租户/会话公平性和可观测队列。RPC 交付队列不等于模型执行池；不能复制“200/8ms”当作我方并发参数，更不能据此声称对方实际无限并行                                |
| 9. 本地工具宿主与会话    | 共享 Node REPL/浏览器/CUA 服务；Code Mode Host 可见 session/cell/execute/wait；工具调用带 thread/turn/call metadata     | tool broker、MCP 已有连接状态复用；本地 workspace 命令每次起 shell，实例内命令队列串行                   | **按资源隔离再并行**：共享无状态机制，保留执行身份。独立工作区才能安全放开文件副作用；不能为降低启动成本复用跨账号特权进程，不能把所有 shell 改为永久共享会话                                   |
| 10. 工具审批与对象校验   | IPC 来源检查、能力注入、普通 data property/冻结、app policy、elicitation、签名/peer 身份；工具缺 thread metadata 会拒绝 | 安装摘要、Run/Tool 证据、当前授权、Proxy/getter 防御、事务撤权、审批证明                                 | **必要复杂度**：两边都有实质安全机制。可集中真实边界的捕获和通用生命周期；不能删除跨 await 当前性检查或降低租户、插件、事务边界。无法证明 ChatGPT 每种业务也采用完全相同检查                    |
| 11. 持久化与派生投影     | 可见 codex.db、state_5.sqlite、目录同步、timeline ledger、automations、summary DB                                       | run snapshots/events、model history、queue/outbox、回执、目录及 UI 派生投影                              | **分层必要，审查重复语义**：执行权威、模型历史、展示缓存用途不同，不能全部压成一张消息表。是否有可删的重复数据要逐表核对写入者与恢复用途；逆向材料不足以证明对方没有队列、租约或同类一致性开销  |
| 12. 生命周期实现         | 共享工具桥、宿主服务及动态目录可见；具体服务关闭算法只部分恢复                                                          | 多个业务 ServiceOwner 重复 invocation/pending/abort/close/retire；已另有 RuntimeCompositionLifetime      | **我方重复可减**：复用小型调用生命周期，保留业务策略。不是因为对方“没有 Owner”；没有恢复的代码不能当不存在。不要再引入万能生命周期框架或巨型继承树                                              |
| 13. 页面与加载边界       | 发布包区分 conversation page/runtime/turn content 和 resume 模块，但原 TS 组件划分、打包基线未知                        | 工作台大组件、多个领域状态同处一页；登录已有 lazy 工作台及依赖按需加载                                   | **按业务页面收敛**：拆真正的状态与装载边界。不能按发布 chunk 名称推断其源码更小，也不能把 CrewON 工作台 2.63MB 当成登录首屏                                                                     |
| 14. 本地/远程与企业身份  | ChatGPT 宿主有 local/remote/durable host 和 account/principal 绑定；renderer 隔离与系统权限分层                         | Electron、Web BFF、Control、Worker、Device Gateway；桌面和服务端有不同身份入口                           | **分工保留**：多部署面确实需要适配。不要照搬本地 IPC 取代 Web 的服务端鉴权，也无需迁到 Rust/Swift。应共享核心用例和策略接口，收敛相同组合过程                                                   |
| 15. 子 agent 关系与停止  | Codex JS 可见 discover/get descendant snapshot 和 turn/interrupt；本地引擎内部完整 spawn/等待/预算实现未知              | Team 会 fork 子 Thread，但还不是通用持久父子任务调度；自主触发能力未完成                                 | **参考显式父子关系和取消传播**：我方需自己设计并验证父子持久关系、限额、等待释放槽及恢复。不能宣称已逆向出它的完整 subagent scheduler，也不能把多会话并行等同于子 agent 系统                    |
| 16. 包入口、类型图和测试 | 发布 JS/原生产物没有原始 tsconfig、项目引用和 CI 测试图                                                                 | store 根入口宽、源码包相互传递；Control/Worker 类型图跨应用，默认测试先构建整套示例                      | **我方独立可减项**：公开子入口、生产/测试类型图分离、专门集成入口。这里无法公平宣称“ChatGPT 构建更轻”或比较双方测试数量                                                                         |

## 从对照得到的四个明确判断

### A. 可以优先精简

1. 固定关闭的旧连接仍被生产 App 装配，以及为它保留的大量转发参数。
2. 一次会话展示被拆成多个独立资源请求，由 UI 反复拼接并校验当前性。
3. Team/Workflow 的执行推进留在 renderer，以及每种业务自建等待/恢复循环。
4. 多个插件业务 Owner 中相同的物理任务收尾和调用生命周期实现。
5. 大包根入口和生产/测试依赖图混合。这是本项目实测，不是通过逆向推断的对方优势。

### B. 不能当过度设计直接删除

流式暂态、最终持久结果、顺序消费、流所有权、快照合并、有限重连、状态兜底、权限与租户隔离、幂等回执、租约、Outbox、未知副作用恢复、插件精确身份、跨异步边界撤权、独立资源作用域。ChatGPT 客户端已明确显示其中多项同类复杂度，其云服务内未恢复的部分则不能判断。

### C. 不应该照搬

- Rust/Swift 多语言实现和所有独立 Host；CrewON 继续用现有 TypeScript monorepo 的边界即可。
- 私有 conversation RPC、delta_encoding、SSE→WS handoff、固定 50ms 重放和 200 项/8ms 常量；当前没有相同需求或性能证据。
- 将所有应用状态压成一个对象，或把所有后端职责移入 Electron 主进程。CrewON 仍要支持 Web 和服务端部署。
- 在未隔离工作区、身份和资源前增加 shell 并发或跨任务复用特权会话。

### D. 当前仍无法下结论

ChatGPT 云端数据模型和服务数量、实际账户并发上限、Rust 任务调度全算法、子 agent 的预算/深度/等待资源策略、完整租约与幂等实现、真实吞吐和内存、原始源码与测试工程规模。任何“对方少一层，所以我们可以删这一层”的结论都需要额外证据。

## 推荐改造顺序

| 顺序 | 具体工作与影响范围                                                                                               | 先保留什么                                                         | 验收门槛                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| 1    | 明确 Control 为当前会话权威，隔离退出旧 App 连接和 handler 装配；同时分离生产/测试类型图、为热点提供公开包子入口 | 仍在用的宿主能力、已有协议和旧数据读取；当前执行和流式行为         | 主场景不依赖已关闭连接；没有能力误删；默认完整检查仍存在；生产依赖图缩小                                        |
| 2    | 后端提供有界一致会话读模型/批量 Run 摘要；前端围绕一次 revision+cursor 快照收敛流、草稿和终态                    | 现有 SSE、临时预览、身份与版本检查、低频恢复兜底、最终 flush       | 同样历史页不再逐个请求全部 Run；流期间读历史不倒退；末尾文本/工具不丢；刷新、切换、重连和停止正确               |
| 3    | 将 Team/Workflow 的阶段推进迁入持久调度，统一使用现有 Run/Tool 执行基础；UI 只提交意图、订阅和处理用户审批       | 旧隐藏 Thread/Message 可兼容读取；原幂等键和审计关系；用户审批     | 关闭页面仍推进；多个窗口不重复启动节点；重启恢复不重放副作用；等待不占满执行槽；取消与审批可靠                  |
| 4    | 复用工具调用生命周期，明确每个 workspace/设备/会话资源的作用域；按真实领域拆工作台页面状态                       | 各业务独立授权及事务检查；共享工作区的副作用顺序；MCP 已有连接复用 | 取消、关闭、超时仍等待真实任务；不同独立资源可并行；同资源冲突受控；不串凭据、输出和状态                        |
| 5    | 在上述底座上加入自主子 agent：显式父子 Run 关系、任务状态、上下文/权限/预算继承上限、结果回传及取消传播          | 人类审批边界、上下文增量与大小限制、工具幂等和租约                 | 子 agent 可独立运行/恢复；父等待释放容量；数量、深度、时间和 token 限额有效；父取消能收敛子任务；结果身份可核对 |

第 1 步是低风险减负，第 2 步同时减少前后端复杂度，第 3 步是自主执行的关键职责调整。第 4 步可以随第 3 步按业务逐个收敛；不应把“先做一个全能插件框架”设成前置工程。第 5 步在调度和隔离验收后再开启，不提前放开递归自主执行。

每一步应单独形成可回滚提交、保留兼容窗口和行为证明；不重写已有模型历史，不为迁移重新发送旧用户请求，不为了减行数删除有效恢复或权限测试。

## 可复核的关键证据

以下路径均相对于逆向目录或 CrewON 根目录。行号是当前本地文件行号，逆向 readable 行号不是原 TS 行号。

### ChatGPT

- `readable/.vite/build/main-CwxgTOle.js:87514`：宿主向连接派发请求，携带 coalesce/priority/timeout/expiresAt/retainResponse 等信息；失败可标为 not-sent。
- `readable/.vite/build/src-DCNiwad_.js:45735`：`handleClientRequest` 准备事件流，再进入 clientRequestQueue；不是模型并发参数。
- `readable/.vite/build/application-network-startup-YSC7OAs0.js:10550`、`:10780`：stdout 有界切片及 setImmediate 调度。
- `evidence/chat-analysis-readable/app-initial-1ab6fbe93c4f.js:63324`：delta 解码顺序队列，afterPending；`:172035` 附近：Ibi 捕获身份与 ownsStream，resume 重放 flush；`:120370`：快照刷新和较新本地消息合并。
- `evidence/chat-analysis-readable/resume-chatgpt-completion-b591b539db2a.js:54`：已有流时返回现有快照；后续普通恢复先查 stream_status。
- `evidence/chat-analysis-readable/app-shared-8340f229c2b3.js:136000` 附近：后代快照、递归停止与 turn/interrupt。它证明取消关系存在，不证明完整调度实现。
- `reports/resources-and-tool-runtime.md:28`：插件包与共享工具运行时；`:40`：冻结、策略与审批；`:57`：桌面工具 metadata 绑定。
- `reports/storage-and-trust-boundaries.md:25`：可见的多层本地数据库/投影及其证据边界。
- `native-analysis/README.md:24`：Code Mode Host 的 session/cell 协议；大型原生引擎未完整反编译。

### CrewON

- `apps/crewon-ui/src/App.tsx:822` 与 `lib/app/effects/useAppConnectionEffects.ts:92`：关闭的旧连接装配。
- `apps/crewon-ui/src/lib/control-runtime/controlTranscriptRead.ts:25`、`:47`：分开查询和按 Run 补读；`controlThreadRuntime.ts:1055`、`:1082`、`:1270` 附近：前后核对快照。
- `apps/crewon-ui/src/lib/control-runtime/controlTranscriptWindow.ts:1`：Control 向旧 Thread/Turn/ThreadItem 展示类型适配。
- `apps/crewon-ui/src/lib/control-runtime/controlTeamRuntime.ts:261`、`controlWorkflowRuntime.ts:435`：renderer 推进与恢复；`apps/runtime-worker/src/workflow-scheduler.ts:10`：实验调度的生产使用边界。
- `apps/crewon-ui/src/lib/control-runtime/controlThreadRuntime.ts:1898`、`controlRunStatusMonitor.ts:43`：SSE 与有界状态兜底；`lib/thread/threadStreamingTextBuffer.ts:41`：当前预览没有打字延迟队列，且有大小预算。
- `apps/runtime-worker/src/runtime-worker-pool.ts`、`runtime-worker-pump.ts`、`resolve-tool-batch.ts`：当前并发、补位与结果前缀提交，不能再用修改前的“整个产品单 lane”描述。
- `apps/runtime-worker/src/local-workspace-command-tool-runtime.ts:95`：共享命令队列；`packages/mcp-runtime/src/stdio-mcp-client.ts:71`：已有连接复用。
- `apps/runtime-worker/src/plugins/project-foundation-tools-service-owner.ts:240` 与 `project-outline-tools-service-owner.ts:233`：相似调用生命周期；业务授权仍有差异。
- `apps/crewon-ui/electron/main.ts:310`：renderer 的 contextIsolation/nodeIntegration/sandbox 边界。
- `packages/store/src/index.ts:8`、`apps/runtime-worker/tsconfig.json:14`：我方入口与类型图的独立减负证据。

前一轮构建、调用计数、导入样本和依赖图保存在 `docs/architecture-weight-audit-2026-10-16.md` 及同名 evidence JSON；本轮未重新做性能对跑，也没有把 CrewON 的实测与 ChatGPT 的静态代码当作同条件性能基准。
