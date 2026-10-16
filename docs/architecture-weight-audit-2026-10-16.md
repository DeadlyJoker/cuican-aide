# CrewON 前后端复杂度对照审查（2026-10-16）

审查基线：`24d7a6343100bc98f53594765fec923a4bf53271`，分支 `codex/runtime-concurrency-result-streaming`。本轮只审查、测量和生成报告，没有修改业务代码或用户数据。

## 判断

存在明确可精简的历史兼容负担、过宽入口、重复生命周期实现，以及职责错位。不能把“文件多”“有接口”“做权限校验”直接等同于过度设计。

前端的主要问题是：工作台接入太多领域，仍装配被关闭的旧连接链路，同时负责服务端业务执行的推进和一致性拼装。后端的主要问题是：包入口把多个业务域和多种物理实现一起带入，插件服务的生命周期机制重复展开，生产与测试的依赖图没有有效隔离。两端的复杂度相互放大。

最应该优先减少的是同一项业务被不同层重复解释和协调的次数，而不是降低租户隔离、持久化和副作用恢复的标准。

## 当前规模和实测

源码计数按 `.ts/.tsx` 物理行统计，排除 `node_modules/dist/output/generated` 和文件名含 `.test.`、`.test-support.`、`.fixture.` 的文件。它包含声明和演示源码，不是可删除行数，也不是运行时负载。

| 范围                               | 文件数 | 源码行数 | 超过 800 行的文件 |
| ---------------------------------- | -----: | -------: | ----------------: |
| UI renderer `apps/crewon-ui/src`   |    755 |  161,333 |                20 |
| Electron `apps/crewon-ui/electron` |     81 |   21,784 |                 1 |
| Control API                        |    256 |   58,775 |                 7 |
| Runtime Worker 的 src              |    261 |   56,019 |                 5 |
| Application                        |    391 |   82,147 |            未单列 |
| Store                              |    502 |  133,442 |                18 |

实际运行 Vite production build，转换 5,330 个模块，用时 35.70 秒；此时间不含 TypeScript 类型检查和 Electron 打包。

| 产物                     |    未压缩大小 |     gzip | 解释                                   |
| ------------------------ | ------------: | -------: | -------------------------------------- |
| WorkspaceApp 主块        |    2,631.22kB | 759.43kB | 登录后工作台入口块，不能算作登录首屏   |
| Mermaid                  |    3,415.09kB | 931.71kB | 已有动态加载                           |
| xlsx                     |      429.19kB | 142.94kB | 已有动态加载                           |
| 登录入口静态 JS 依赖合计 | 326,435 bytes |   未合计 | 实际运行现有启动检查，低于 512KiB 上限 |

因此不建议把第一刀放在删除 Mermaid、文档解析或 React 依赖。图表、表格、Word 解析和设置页已经有按需加载；工作台内部的业务聚合更值得检查。包体并不等于实际浏览器耗时，本轮没有浏览器 CPU、内存或交互性能 trace。

## 前后端对照与优先级

| 优先级 | 问题                         | 前端表现                                                                               | 后端表现                                                               | 建议                                                                  |
| ------ | ---------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| P1     | 关闭后仍保留的兼容装配       | `App` 将旧连接固定为 `enabled: false`，仍装配旧事件、领域、设置协调器和 client 回调    | 仍保留多种入口契约，消费者通过兼容 DTO 连接                            | 先隔离旧入口，按生产可达性退休对应装配，不能按名称批量删除            |
| P1     | 展示读取承担分布式一致性拼装 | 多次读 Thread head，单独读消息、活动 Run、历史 Run、变更台账，再判断 revision 是否一致 | API 粒度过细，没有直接给 UI 一个有界一致的读模型                       | 增加一致快照或批量读模型，减少往返和前端竞态分支                      |
| P1     | 包和类型检查边界太宽         | renderer lint/build 同时检查 src 下测试；后端检查也拉入 Electron 文件                  | store 根入口重导出 Application；SQLite、PG、内存实现一起经聚合入口加载 | 生产/测试 tsconfig 分开，提供按领域和物理适配器划分的公开子入口       |
| P1     | 执行编排放错层               | Team/Workflow/Expert runtime 在 UI 管理 fork、启动、等待、恢复和汇总                   | 后端有实验工作流调度，却没有成为生产调度权威                           | 把业务执行推进迁到持久调度，前端保留提交、显示、用户决策              |
| P2     | 一个页面组件承载过多业务     | 4,619 行、84 个 props 成员，文件内 47 次 useState、23 次 useEffect                     | 大服务/Store 又把多个业务域暴露到组合根                                | 按页面/领域建立真正独立的状态所有者，不只是把函数挪到更多 helper 文件 |
| P2     | 同一生命周期机制反复实现     | UI 插件接入需要理解多层 host 与 availability 适配                                      | 多个 ServiceOwner 复制 invocation、pending、abort、close、retire       | 收敛少量机制代码，保留各自业务身份和事务授权                          |
| P1     | 普通修改付出完整插件集成成本 | 测试和类型图混入整个宿主链                                                             | runtime 默认测试先构建所有示例；若干用例又依赖未提供的冻结产物         | 区分单元/协议/插件集成/桌面 E2E，冻结 fixture 必须可重建或显式提供    |

## 1. 关闭的旧连接仍参与生产工作台装配：高可信可减项

证据：

- `apps/crewon-ui/src/App.tsx:822` 调用 `useAppConnectionEffects`，`enabled` 写死为 false。
- `apps/crewon-ui/src/lib/app/effects/useAppConnectionEffects.ts:92` 在该条件下关闭并清空 `clientRef`。
- `apps/crewon-ui/src/lib/app/useAppCoordinatorRefs.ts:8` 将旧 AppServerClient ref 初始化为 null。
- `apps/crewon-ui/src/lib/control-runtime/threadRuntimeAuthority.ts` 的两条返回分支均令 `legacyManagesThreads: false`。
- 但 App 仍创建旧事件处理器、领域协调器，并向大量 handler 传递 `clientRef.current`；Control 读取结果还被投影到旧 app-server 的 Thread/Turn/ThreadItem 类型，见 `controlTranscriptWindow.ts`。

判断：这是比“某文件很长”更具体的兼容负担。当前工作台已经明确选择 Control，会话链路却还要维护旧协议的形状和旧装配接口。

影响范围：入口 App、lib/app、domain/app-server、旧事件处理与 settings/library 适配。先列出生产引用和仍依赖旧能力的具体场景，再单独切断旧入口；不能声称整个 app-server 目录已经没有消费者，也不能顺手删除仍有实际职责的终端、资源或宿主能力。

## 2. UI 为细粒度接口支付重复读取和竞态成本：高可信结构问题

直接执行现有 `readControlTranscript`，用 10 个不同历史 Run 的可控客户端桩计数：共发出 12 次客户端调用，即消息窗口 + 活动 Run + 10 次按 Run 读取。该测量验证调用次数，不是实际 HTTP 延迟。

证据：

- `controlTranscriptRead.ts:25` 同时读 transcript window 和 active Run。
- `controlTranscriptRead.ts:47` 以最多 4 路并发逐个补历史 Run；窗口上限为 50 条消息，成本随关联 Run 数量增加。
- `controlThreadRuntime.ts:1055` 先取 Thread snapshot，`1082` 再核对一次；完整投影在 `1270` 附近还会核对 hydration 后 snapshot。
- 同一流程还可能读取 task-change ledger、plan 和工具历史。因此 12 次只是该子函数，不是整个页面读取的总请求数。

现在的 revision、身份、游标检查有实际一致性价值，不应删除。应该让后端用一个有界读模型返回同一快照下的消息窗口、活动 Run 和必要 Run 摘要，或先提供批量 Run 查询。然后前端再减少因独立请求竞态而存在的重试、缓存覆盖和回滚判断。新 endpoint 仍须保留分页、租户过滤、revision 和事件游标，不能改成一次返回全部历史。

这是需要前后端一起改的问题：只改前端轮询频率，或只把请求包装成另一个 hook，无法消除根因。

## 3. 前端业务执行器与后端实验调度并存：职责错位

`controlTeamRuntime.ts` 在 renderer 做 fork、分配消息、启动 manager/worker Run、等待和汇总。`controlWorkflowRuntime.ts` 将运行状态编码到隐藏 Thread/Message，`list` 相关路径读取到 running 执行后还会调用 `#resumeExecution`（435 行附近），实例内用 Set 防重复继续。

这不等于刷新后状态丢失：已有记录可以重建，而且存在幂等和版本保护。但“恢复后继续推进下一节点”由 UI 实例触发，读取列表也带执行推进副作用，增加了多窗口、关闭页面和恢复时的协调成本。

后端的 `ExperimentalWorkflowScheduler` 明确不由生产 bootstrap 构造（`apps/runtime-worker/src/workflow-scheduler.ts:10`）。所以不是直接打开一个开关就能删前端实现。

建议围绕一个生产可用的持久执行状态和调度入口迁移 Team/Workflow，而不是为每种场景再加一套引擎。完成一个节点后，后端记录状态并决定后继；前端订阅结果，用户审批仍通过明确命令提交。自主子 agent 应接在这条后端执行链上。

参考用户提供的 ChatGPT 静态逆向报告 `reports/desktop-host-and-app-server.md`：可借鉴宿主管理请求队列、连接和工具派发的责任划分。不能据此声称 ChatGPT 的业务逻辑全在主进程，也不能用发布包行数证明哪一方总源码更少。

## 4. 大包根入口和源码级传递引用：有实测成本

`packages/store/src/index.ts:8` 直接 `export * from "@crewon/application"`；同一个入口还导出 SQLite、PostgreSQL、内存 Store、报表和大量业务实现。Application index 有 268 个 export 起始语句。普通消费者只要其中一个实现，也要进入很宽的模块/类型依赖图。

在新的 Node 24 进程中分别导入，三次样本：

| 导入方式          | 样本耗时             | 中位数 |
| ----------------- | -------------------- | -----: |
| store 根入口      | 1588 / 1672 / 1485ms | 1588ms |
| SQLite 实现源文件 | 1111 / 1062 / 1440ms | 1111ms |

仅测模块导入，未打开数据库；直接源文件仅用于诊断，不建议消费者绕过公共 API。测试不是严格随机交错或隔离 CPU 的实验，不能把全部差额归因于一个 export。RSS 区间有明显重叠，不能据此报告内存下降。它至少证明当前无数据库操作的导入路径也不轻，且叶子实现仍会进入其他聚合入口。

建议先提供显式公开的 SQLite、PG、testing 入口及少量领域入口，再迁移热点消费者。不要为了拆包再创建第二套运行时、通用服务容器或泛型仓储 DSL。

## 5. 编译和测试将不同应用绑在一起：明确可减的工程成本

使用现有 tsconfig 执行 `tsc --listFilesOnly`，按仓库路径统计（包含测试、声明和 SDK 类型产物，不是运行时装载）：

| 检查对象       | 仓库内文件 | 其中测试/辅助/fixture | 带入其他应用                                  |
| -------------- | ---------: | --------------------: | --------------------------------------------- |
| control-api    |       2420 |                   424 | runtime-worker 233；UI 60（其中 Electron 59） |
| runtime-worker |       2497 |                   467 | control-api 248；UI 58（其中 Electron 57）    |

两者配置均 include `src/**/*.ts`。测试和辅助文件跨应用直接导入实际组合根，是图变宽的一个具体原因；宽包根入口又放大这一问题。不能将这些数字当作生产 API 会启动 UI 或 Worker 进程的证据。

我上一轮新增的跨应用 SSE 集成测试也沿用了此模式，它应计入这次审查，不能把所有负担归于历史代码。

建议：生产和测试类型检查分开；跨应用 E2E 留在专门入口；普通单元测试不承担整个产品组合根。再逐步使用现有 TypeScript 项目引用/稳定类型产物，让共享包检查结果可复用。最终默认验证仍须覆盖原有行为，不应通过排除有效测试换取通过。

runtime 默认测试脚本在读取 test 参数之前，先构建完整业务插件样例（`apps/runtime-worker/scripts/test-installed-plugin-examples.mjs:22`）。普通核心改动也付出打包多个插件的准备成本。冻结包还存在可重现性缺项：`desktop-native-project-media-input.test-support.ts:96` 默认读取 output 下 Short 21/23/26 的产物；当前 checkout 未提供这些文件。应让集成 fixture 可明确构建或声明来源，不能把忽略目录当成测试环境的隐含前提。

## 6. 重复生命周期实现可收敛，授权边界不能一并抹掉

Foundation、Outline、Asset、MediaInput 和通用 Project 的 ServiceOwner 都各自实现 invocation WeakMap/active/pending、AbortController、withInvocation、canRetire 和 close。Foundation 的 `240` 行附近与 Outline 的 `233` 行附近包含结构上几乎相同的调用进入与 finally 清理流程。

可以提取很小的调用生命周期/物理任务所有者，减少每新增业务服务都复制一套机制的成本。具体的安装 pin、Run/Tool 回执、事务授权、资源作用域和撤权后检查仍留在业务服务中。不同 Owner 的借用、取消和关闭语义未必相同，不应把它们塞进一套万能 policy 配置或继承树。

源码里的 Proxy/getter 防御也不能仅因重复出现就判断多余：插件对象和 JSON 请求属于不可信边界。更合理的是在真实边界统一捕获、验证和形成明确的内部类型，减少内部重复解析；跨 await 的撤权/TOCTOU 检查不能因“之前验证过”而删掉。本轮未实测这些检查的 CPU 占比，不把它们列为已确认的延迟主因。

## 7. 巨型模块是职责未收敛的信号，不能靠搬文件解决

- `CommandWorkspace.tsx`：4619 行，84 个 props 成员；文件内 47 次 useState、23 次 useEffect、13 次 useMemo、12 次 useRef（AST 计数）。
- `App.tsx`：1969 行；其 lib/app 目录另有 94 个生产模块，共 11,685 行。
- `controlThreadRuntime.ts`：3176 行，混合读取、流式投影、恢复和多个业务入口。
- `runtime-worker.ts`：3627 行；`run-execution-service.ts`：3399 行；`sqlite-run-store.ts`：7550 行。

前端建议按 Conversation、Team、Plugin Workbench、Catalog、Settings 建立独立页面状态和加载边界，共用壳保留导航/当前选择。当前已经拆出了很多 hook/coordinator，继续抽更多只做转发的 helper 未必减少耦合。

后端按执行、回执、历史、队列、目标和项目等职责收敛，但需要留住同一数据库事务里的原子提交。SQLite/PG 的锁和事务行为不同，不应为统一代码行数而改成最小公分母的通用仓储。

## 保留的必要复杂度

- Web BFF 的浏览器身份/CSRF/服务凭据边界、Control 的 HTTP 与租户授权、Worker 的副作用执行边界；不是进程多就应该合并。
- Run/Tool 租约、幂等、未知副作用恢复、Outbox、SSE 游标及重连。
- 插件精确版本与摘要、撤权、事务当前性和数据隔离。
- SQLite 本地与 PostgreSQL 服务端的不同物理实现；是否继续支持某一种需产品部署决策，不能从本地开发成本自行推导。
- 流式显示的暂态状态、用户草稿和必要缓存；不要求 UI 完全无状态。

## 建议的精简顺序与验收

1. **先做可逆的工程减负和旧入口隔离。** 生产/测试类型图拆开，插件集成测试独立入口，增加公共子入口；清点固定关闭的旧 App 装配。验证普通改动是否不再触发全插件准备、生产入口图是否缩小、默认完整检查是否保留。
2. **前后端一起合并会话读模型。** 从一页历史的请求计数着手，保留游标、预算和版本一致性；验收切换会话、流式期间读取、刷新和重连。不要以一个大 HTTP 接口包装多个无一致性保证的查询冒充原子快照。
3. **将 Team/Workflow 推进迁回持久调度。** 验收关窗口后继续、重开后恢复、多个窗口不重复推进、取消传播和用户审批，再接自主子 agent。
4. **收敛插件 Owner 的重复机制和工作台页面状态。** 每次只迁移一个领域，证明代码及依赖减少，保留原始权限、故障恢复和视觉行为。

本轮验证包括源码和调用链检查、AST 计数、实际 Vite 构建、现有启动预算检查、tsc 文件图、模块导入测量与会话读取调用计数。没有进行删代码实验、浏览器运行时 profile 或生产压力测试，因此不承诺可删除比例、提速百分比或内存收益。
