# 私有 Native 项目工作空间分配桥

这轮实现是独立基础模块，尚未接入 Main / RuntimeSupervisor 启动、Control 业务服务、中央 Agent 或插件 UI。真实子进程测试确认可以在实际 Node IPC 测试子进程的通道上调用原 `LocalWorkspaceAuthority` / `LocalWorkspaceProjectAllocator`，没有新增工作空间管理系统、HTTP 服务或 renderer IPC。

## 发行与请求边界

- Main 的 `DesktopNativeProjectWorkspaceBridge` 只借用真实 Native authority factory 发行的对象、真实原工作空间 authority 和指定的活跃 IPC child。Native authority / policy 的复制对象、结构替身或另一个 bootstrap / dataDirectory 的 policy 均不能发行桥。
- Main 内部 `prepare({ projectId, packageIdentity })` 仅接受这两个字段。package 四字段必须精确匹配当前固定 Native policy；`perAction` 包因本模块没有实际动作批准来源，明确拒绝。Main 根据真实 pin 派生 tenant / space / principal / actor / profile / plugin / publisher，projectId 由未来受信 Host 调用方签发。version / digest 是当前批准检查条件，不加入稳定空间 identity。
- 一次性票据只授权这个固定 owner 的空 Native 工作空间分配。票据绑定具体 child 对象、桥 generation、Native authority ID 和 bootstrap epoch，默认有效期 5 秒，配置范围为 10–30000ms，最多 16 张未消费票据。
- 私有 wire 仅接受严格三个字段：`schemaVersion / requestId / ticketId`。不能从 wire 准备票据、提供项目/包身份、owner、账号、路径、workspaceId 或 recover 动作。已知票据在字段验证和排队前消费；错误输入、失败、超时或发送错误均不恢复票据。
- 排队前仅保留冻结的三段有界 ASCII 字符串，或无效请求的有界 requestId；不保留原 IPC JSON。最多 4 个请求/响应等待操作；超量撤回本桥。其他私有协议消息不读取、不消费其引用票据、不移除其监听器。Node IPC 自身的解码发生在模块之前；这里的边界是本模块捕获和排队的输入，不声明限制 Node 的通道总内存。

Control 子进程身份仅证明 transport。Node 插件可能在所属进程中运行，故 child 身份不能证明用户、插件项目或 Agent 动作授权。未来产品接线必须从原真实 Host 请求或 Run / Tool receipt 取得项目资格，不能让插件/renderer 调用 Main prepare，不能用已有 Worker peer token 代替这里的票据。

## 原项目授权准备

原 `ProjectConversationApplicationService.prepareWorkspaceFromPluginUi` 现提供内部准备入口：先核对真实 UI invocation 与独立 Conversation Host pin，再只允许原 `createConversation` 操作，从输入取得已有 projectId，经原 SQLite 绑定读取视图核验完整项目归属、原 principal、活动状态及独立 `creativeProject:write` 策略。没有 protected owner 的 legacy 项目、别人的项目、普通列表/读取、缺少 adapter 或部分 schema 均不能取得准备引用；不会自动迁移、接管旧项目或替代项目首次创建权限。

返回的是进程内 opaque reference，复制或 JSON 往返失去资格。内部消费者通过 `qualifyPluginProjectWorkspacePreparation` 取得冻结的完整八字段 owner、当前准确包四字段和预期工作空间 ID，每次操作前仍须调用 `assertCurrent()` / `assertActive()`。current 检查再次读取原项目状态和归属，在原 Host 最后一次异步检查后再次检查项目 write 策略；UI 完成、Host 关闭、安装/epoch 漂移和撤权均使准备失效。此引用不能授权 namespace 写入、Thread 创建、Run、Tool 或访问已分配目录。

工作空间 ID 与原 Native allocator 使用同一 Domain 身份字节配方，仍是原字段顺序的 JSON 数组经 SHA-256 后加 `workspace-project-` 前缀。原 Native ID 字节保持，版本与包摘要不加入稳定 owner。UI 若已指定 workspaceId，它必须匹配宿主派生的 ID；null 仅表示这次内部准备没有 caller 指定 ID，不改变原 createConversation 的 null workspace 校验或返回协议。新的准备入口目前未被产品 dispatcher、Main prepare 或 SQL writer 使用，不能当成已接通的项目创建体验。

准备专项使用真实 UI 注册、原 Application 与 SQLite Store；Host callbacks、包发现及 protected metadata 为命名 fixture。覆盖完整归属、原策略、最后 Host await 后撤权、只读入口拒绝、legacy 拒绝、任意空间拒绝、缺少 reader、复制引用、调用结束与持久归档状态复核。归档状态用显式 SQL fixture 改变，不宣称新的归档管理入口。准备本身不分配 ID、Thread、Run、目录或 namespace。与 Domain 身份字节、新旧 Native allocator/bridge/client 和原 installed HTTP 兼容专项联合 **119 passed、0 failed、0 skipped**；Domain/Application/Store/Control/Electron 类型检查、架构边界及格式检查通过。本轮没有运行 PostgreSQL 新准备模式，也未部署 Web 或正式桌面。

## 分配、撤回与恢复

消费只调用原 allocator 的 `provision()`：沿用原 registry、真实目录、全程排他 lease、字节 CAS 和 Native pending/registered/failed journal。不激活新目录，不更改主会话当前工作空间，原文件读取 lease 保持有效。

已 pending / failed 的 Native intent 只被观察，不隐式调用 recover。重放同一个 owner 的已注册空间沿用原 workspaceId 和文件；新票据必须由 Main 再次明确 prepare。后续恢复能力需独立受信资格，本模块没有恢复 wire。

prepare、消费及发布末端复核真实 Native pin / scope / epoch、原工作空间 authority 和 child 状态。Native owner 的真实 withdraw、外部 signal、child disconnect / exit / error / close，以及本桥 withdraw 均同步撤回 unused tickets。文件 pin 变化在这些检查点失效。

Native 文件提交和授权撤回不构成跨进程原子事务：授权可能在真实目录/registry 提交后失效。这时拒绝发布有效观察，保留真实 journal 和目录，不伪造回滚，也不使 consumed ticket 可重用。`registered` 只表示 Native 目录/registry 观察，不能证明 SQL namespace、metadata ownership、Thread / project binding、用户操作权限或 Agent 可用。

响应与 send callback 有期限；`send()` 返回 false 只是背压，callback error / 超时撤回本桥。已交给 Node IPC 的字节无法在不关闭共享 child 的条件下撤销；Control adapter 必须核对原活跃请求、票据关联和 deadline，且 SQL 提交仍需原事务资格，不能把迟到 Native 状态当作 grant。

`close()` 撤回本桥、等待其有界请求/发送处理，移除自身 handlers；不会杀死/断开 Control、撤回共享 Native authority 或删除其他 owner 的文件和监听器。真实 child 与 Native authority 的物理退出/清理由原 supervisor 管理，本模块不接管它们。

## 原 Control 请求端

`apps/control-api/src/desktop-native-project-workspace-client.ts` 现提供配套的私有请求端，仅使用实际 Control 子进程的 `process.channel` / `process.send`，不接受 caller peer、账号、owner、projectId、路径或 workspaceId。同一模块在实际进程中只有一个活动请求端；票据必须先由 Main prepare。Main 与 Control 使用 contracts 中同一份 wire 类型和严格快照解析，原 schema 与字段不变，没有新增 renderer、HTTP 或 plugin SDK 分配接口。

请求端一次发送、最多四个等待请求或发送处理，不排重试队列。票据过期或 caller signal 已撤回时不发送；响应只匹配原随机 requestId。其他协议与未知关联不触碰等待中的请求；已知关联的扩展字段、普通工作空间 ID、非法状态、getter 或其他畸形值拒绝，未收到响应或 send 失败有界退出。超时、caller abort、请求端撤回和实际 parent disconnect 都不会重发请求，也不会把迟到响应交给业务调用。close 移除自己的监听器、等待有界 send callback 处理，不断开进程或删除已经提交的目录。Control abort/超时不能撤销 Main 已开始的文件分配，后续业务必须重新核对资格与真实状态，不能声称文件回滚。

新专项的 child 实际加载上述 Control 源码，通过 Node IPC 调用原 Main bridge 和原 allocator，覆盖真实目录、活动空间保持、一次性票据、明确同 owner 重放、超时、坏响应、并发上限、撤回、实际断连和自身监听器清理。与原 Main bridge 联合 **52 passed、0 failed、0 skipped**；新 portable wire 两项测试通过，合计 **54 passed**。Contracts、Control 和 Electron 类型检查、架构边界及格式检查通过。这里的 ticket 来源仍是受信 Main 测试调用，没有接入实际 Host 项目授权，尚不能证明 namespace、会话、Agent 或 Web 产品闭环。

后续请求端已增加 `allocateForProject({ preparation, ticket, signal? })`，只消费原 Application 发行的活跃准备引用，拒绝扩展字段与 getter，并在异步检查前快照票据。分配前、返回后分别重查完整项目归属、活动状态、当前 Host/UI 与独立 write 策略；返回的 workspaceId 必须等于宿主派生 ID。复制准备 JSON、其他项目的 Native 结果或分配后撤权均不能成为有效的项目观察。失败时不重试、不删除可能已经提交的 Native 文件，不签发 namespace、Thread、Run 或目录访问权限。

对应 child 使用真实 UI 注册、原 SQLite 绑定读取和这个 scoped client，与真实 Main/Native allocator 同时工作。它沿用真实桌面固定运行 actor 和符合原 UUID 格式的 profile；没有放宽生产 bootstrap 的 actor/profile 校验。初始 protected metadata、包发现和独立 Host 策略为命名 fixture；没有配置会话、namespace 或任务写端口。正例确认 Native journal 与 UI 来源的完整八字段归属相同，当前活动目录保持；负例验证复制引用、错项目与 Native 提交后撤权。Main ticket 仍由受信测试调用方 prepare，未接入产品的跨进程资格发行器，也未证明当前包四字段与票据在产品入口的绑定。原未 scoped 的 `allocate` 仍是内部 transport primitive，不允许拿它的响应作为 SQL/Agent 授权。

新增四项与原 Main/client 联合 **56 passed、0 failed、0 skipped**；Store/Control/Electron 类型检查、架构边界与格式检查通过。失败测试产生的八个专属 Native fixture 目录已核对并清理，fixture 初始化失败也会自行清理；未更新 Web 或正式 App。产品 dispatcher、Main 票据发行、SQL 登记与中央会话的完整接线仍未完成。

## 兼容性与验收范围

### 原 SQLite 登记

Control 的 `observeForProject` 现将已核验、属于同一 owner 的 registered Native 响应绑定到原活跃项目准备引用，生成五秒内有效的进程内观察引用。实际 client 关闭、parent 断连、UI 调用结束或项目资格失效时拒绝；复制 response/reference JSON 不能作为 Store 登记凭据。`@crewon/application/host-project-workspaces` 是明确的可信 backend 发行入口，未加入 plugin SDK、Host service 或 HTTP。发行函数依赖受信 Control 实现已检查真实 parent 响应，并不是对恶意同进程代码的安全沙箱；跨进程 Main 的准确包/资格发行器仍需接通。

`SqlitePluginProjectWorkspaceStore.recordFromNativeObservation(reference, { createdAt })` 复用同一个原数据库和原 namespace 写配方，不接受 caller owner、projectId、workspaceId 或目录。提交和回放在原事务核对安装、完整 metadata owner、原 principal 及 active project；提交末端再次核对。缺失或部分 schema、legacy 项目、已有不同登记或原会话历史仍拒绝，不能接管旧项目。新的 replay 保留第一次登记的 createdAt，Host 后续时钟不会改写原记录；旧 `recordFromPluginUi` 的严格 recipe 与 legacy 行为保持。

实际 child 的真实 UI → 原项目读取 → 实际 Native 分配 → 原 SQLite namespace 交易已通过一次提交、回放、复制引用拒绝和调用结束后拒绝。归档、部分 schema、独立策略撤回与最后 Host await 后撤权均不登记；显式 SQL trigger fixture 在 namespace INSERT 后改变项目状态，提交末端拒绝并一起回滚 namespace 和状态改变。Native 目录/registry 已提交的部分保留，当前活动目录不变，没有伪造跨进程整体回滚。初始 metadata owner、包发现及 Host 策略仍是命名 fixture，不是实际 installed HTTP 首次创建或正式项目入口。

该入口现已加入原 `SqliteRunStore.pluginProjectWorkspaceNativeRegistrationStore()`，沿用同一 Parent 连接与生命周期。原 namespace 读取、显式迁移、旧 UI 登记和新 Native 登记由聚焦的 `sqlite-project-workspace-ports.ts` 委派同一个 Store 实现；读取视图与新登记视图分别冻结，构造不迁移、不创建目录或签发观察资格。原读取和旧登记的关闭/授权检查顺序保留。

实际 Native scoped 集成现也通过原 Parent facade 登记；项目与安装读取沿用 Parent Store，专属文件数据库的第二连接只供显式 owner fixture、状态观察与负例 trigger 使用。触发器在专属数据库内可被真实 Parent 交易观察，namespace INSERT 后归档仍被提交末端拒绝并回滚。Parent 构造专项证明无 namespace 表时获取读/登记视图不建表，复制观察拒绝，关闭后无法再取新视图。当前联合 **86 passed、0 failed、14 skipped（PostgreSQL）**，包含 Native **62 passed**、原 SQLite namespace **23 passed** 与新 Parent **1 passed**；类型、边界与格式检查通过。本轮未运行 PostgreSQL。没有 Main/Control 产品 bootstrap、Conversation 原交易或 PostgreSQL Native adapter；实际 Thread、中央 Agent 与 Web/桌面完整体验仍未验收。

新旧 Native scoped/client/bridge 专项 **62 passed**；原 namespace、metadata fence 及 owned Conversation UI 的 SQLite/PostgreSQL 兼容专项 **50 passed**，联合 **112 passed、0 failed、0 skipped**。PostgreSQL 18.6 专属测试实例随后停止清理，验证的是原兼容入口，不代表新 Native 登记已支持 PostgreSQL。Application/Store/Control/Electron 类型检查、边界与格式检查通过；正式 App 未更新。

### 原会话创建的宿主组合入口

原 Application 现有内部 `createConversationFromNativeObservation({ context, authority, observation, registration })`，先确认真实 UI、独立 Conversation Host 权限与 Native 观察来自同一个完整 invocation fingerprint，原 createConversation 输入 workspaceId 必须等于宿主派生 ID。另一个相同 owner/project 的 UI 调用也不能借用该观察。登记端口只捕获 data method，不执行 getter；随后调用原 Parent 登记、重查项目资格，再沿用原 createConversation 私有配方、完整回执范围和原 Thread/binding/receipt 交易。

公开请求、响应和原 nullable workspace 校验没有变；此入口没有将 null 请求改写为另一个 workspaceId，也没有制造 UI invocation 或重写既有 Thread。实际 child 测试沿用已有协议明确提供宿主派生 ID，验证真实 Native 目录、Parent namespace、一个原 Thread 及同键回放，观察借给其他 invocation 或 getter 登记端口时拒绝。初始 metadata、Host 策略和包发现仍为命名 fixture，Main prepare 仍由受信测试调用方执行；这是内部组成链路，不是完整产品安装或 Web 验收。

组合 Native 专项 **63 passed**，原 installed HTTP 创建/关联/升级 **5 passed**，联合 **68 passed、0 failed、0 skipped**。类型、边界与格式检查通过；此次初始化失败产生的 23 个专属 fixture 目录已核对并清理，初始化失败与 child 退出路径也增加清理。产品 dispatcher 和 Main/Control bootstrap 仍未调用这个组合入口，中央 Agent、PostgreSQL 新模式及正式 Web/桌面未验收。

原 Native policy / authority persisted DTO、workspace registry、allocation journal、HTTP / SDK / renderer contracts 均保持原 shape。唯一收紧是 Native authority 的内部 factory 要求同一真实 reader 发行的 policy，不能传结构替身、复制品、别的目录或别的 bootstrap。已核对全部生产/测试 factory callers；它们原本均使用同一真实 reader。

测试使用实际 Node child IPC、真实 Native bootstrap / policy / authority producer、原工作空间 registry 和真实文件系统，覆盖一次消费、坏输入、大输入、其他协议、批准/perAction、结构替身、跨 child/generation、Native 撤回和 pin 变化、Native 提交后的拒绝发布、active workspace / file lease、原 registry stale-byte fence、失败不恢复、发送背压/错误/期限、请求超量和 close 的监听器/文件归属。

固定 Node 24 的五文件兼容专项通过 148 / 148 项，无跳过；其中新 bridge 专项 46 项。实际 IPC disconnect / send error 场景的 fixture 清理等待真实 child `exit` 和各自拥有的 stdout / stderr pipe `close`，不依赖该场景可能缺失的 ChildProcess 聚合 `close`，没有放宽 hook timeout。

```bash
pnpm --filter @crewon/ui exec vitest run electron/desktopNativeProjectWorkspaceBridge.test.ts electron/desktopNativeInstalledPluginRuntime.test.ts electron/desktopPluginBootstrap.test.ts electron/localWorkspaceProjectAllocator.test.ts electron/localWorkspaceRegistry.test.ts
pnpm --filter @crewon/ui exec tsc --noEmit -p electron/tsconfig.json
pnpm crewon:boundary:check
pnpm format
```

尚未完成：Main 实际启动桥与 Control child fd、真实 Host 项目请求/receipt → Main prepare、Native 观察 → 原 SQL namespace 登记 → 原 Thread/binding，以及中央 Agent provisioning。受保护 metadata 首次创建已有真实 installed HTTP 证据，见[项目管理隔离](./plugin-project-management-isolation.md)，不代表这里的目录链路已接入它。namespace 登记和 Conversation SQL 目前为独立事务，不能声称整体原子提交。当前测试不能据此宣称产品项目创建闭环或插件 ready。
