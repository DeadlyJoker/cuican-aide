# CrewON 当前与未来总体架构设计

更新时间：2026-07-19

> [!IMPORTANT]
> 本文的“当前”部分仍用于记录 2026-07-19 的实现基线；“未来”部分已被
> `ARCHITECTURE_FINAL.md` 取代。后续目标架构、技术选型和完成 Gate 以最终态文档及
> `artifacts/architecture-next/` 下的 ADR 为准，本文不再作为新增功能的目标设计依据。

Wave、SDD 产物、Harness 和任务提示词见 <code>artifacts/crewon-platform-wave-sdd-execution-guide.md</code>。

本文以当前仓库真实代码为基线，分别描述：

- 当前跨服务总体架构。
- 当前 CrewON 本服务内部架构。
- 当前单 Agent、云 Agent 和办公室的核心执行流程。
- 当前办公室执行泳道。
- 未来目标总体架构与内部模块边界。
- 未来统一任务执行流程与跨服务泳道。

图中“当前”表示已经存在真实代码或真实 RPC；“未来”表示推荐目标设计，不代表已经实现。

完整中台安全与正确性规则以 `artifacts/crewon-platform-security-correctness-baseline.md` 为准；本文件负责说明当前事实、目标结构、执行流程和泳道。

## 一、当前总体架构

### 1.1 当前跨服务架构

```mermaid
flowchart LR
    subgraph Clients["客户端"]
        Desktop["CrewON PC / Tauri"]
        Web["CrewON Web"]
        Mobile["移动端客户端"]
        UI["apps/crewon-ui<br/>当前 PC / Web UI"]
        Desktop --> UI
        Web --> UI
    end

    subgraph Access["接入与开发运行层"]
        Proxy["接入代理<br/>开发：Vite Proxy<br/>部署：反向代理"]
        DevSupervisor["本地开发 Supervisor<br/>健康检测、自动重连、受控重启"]
    end

    subgraph CrewonService["cuican-aide / CrewON"]
        AppServer["crewon-app-server<br/>JSON-RPC 控制面"]
        Core["CrewON Core Runtime<br/>Thread / Turn / Item / Agent Loop"]
        OfficeRuntime["Office Team Runtime<br/>Leader、委派、调度、恢复"]
        ResourceRuntime["资源与配置管理<br/>Agent / Skill / MCP / Knowledge / Plugin"]
        ExternalAgentProxy["Agent Platform 会话代理<br/>本地派生会话历史"]
    end

    subgraph AgentPlatform["Agent Platform 服务"]
        PlatformAPI["Agent Platform API<br/>认证、资源目录、下载、Open API Agent"]
        PlatformData[("平台数据库与资源存储")]
    end

    subgraph External["模型、工具与执行环境"]
        ModelProvider["模型服务<br/>Responses / Realtime API"]
        MCPApps["MCP Server / App Connector"]
        LocalWorkspace["本地工作空间<br/>文件、Git、Shell、PTY"]
        RemoteEnvironment["远程执行环境<br/>Exec Server / Environment"]
        RemoteControl["远程控制与云配置<br/>部分能力仍为实验态"]
    end

    subgraph Persistence["CrewON 持久化"]
        CrewonHome[("$CREWON_HOME<br/>配置、认证、Agent、Thread Rollout")]
        WorkspaceState[("工作空间 .crewon<br/>Office、Run、Memory、Scheduler")]
    end

    UI -->|"WebSocket JSON-RPC<br/>/app-server"| Proxy
    Mobile -->|"JSON-RPC 传输适配"| Proxy
    Proxy --> AppServer

    UI -->|"REST<br/>/agent-platform-api"| Proxy
    Proxy --> PlatformAPI

    AppServer --> Core
    AppServer --> OfficeRuntime
    AppServer --> ResourceRuntime
    AppServer --> ExternalAgentProxy

    ExternalAgentProxy -->|"HTTPS / SSE<br/>云 Agent 执行"| PlatformAPI
    PlatformAPI --> PlatformData

    Core -->|"模型推理"| ModelProvider
    Core -->|"工具发现与调用"| MCPApps
    Core -->|"受权限和沙箱控制"| LocalWorkspace
    Core -->|"可选远程执行"| RemoteEnvironment
    AppServer -.-> RemoteControl

    AppServer --> CrewonHome
    OfficeRuntime --> WorkspaceState
    ResourceRuntime --> CrewonHome

    DevSupervisor -.->|"端口检测、失败重启"| AppServer
```

当前跨服务边界：

- 前端通过 app-server 执行 Thread、Turn、Office、Automation 和本地工具能力。
- 前端直接通过 Agent Platform REST API 完成登录、目录读取、资源下载和部分平台资源调用。
- 云 Agent 的执行请求由 app-server 代理到 Agent Platform，平台密钥不暴露给前端。
- Agent Platform 云 Agent 的派生会话历史独立保存，不注入 CrewON Core 的本地模型上下文。
- Office 配置与共享运行账本属于工作空间；普通 Thread Rollout 和用户级配置属于 `$CREWON_HOME`。

当前必须优先修正的中台安全缺口：

- Agent Platform Open Agent API 验证 Space API Key 后，Agent 查询仍需绑定同一 tenant/space/resource ownership。
- UI 仍执行部分 Provider MCP/KB Dynamic Tool；服务端接管时必须同时删除 UI 执行路径。
- 新 API 的 Actor、memberId、Workspace Root 和 Credential owner 必须由服务端派生，不能扩散当前客户端 JSON 配置模式。
- Office 迁移前必须给所有旧 dispatch/写入入口增加 migration fence，并处理活动旧 Run。

### 1.2 当前 CrewON 本服务内部架构

```mermaid
flowchart TB
    UI["CrewON UI<br/>CommandWorkspace / Conversation / OfficeWorkspace"]

    subgraph FrontendRuntime["前端应用运行层"]
        AppState["应用状态与路由<br/>工作空间、线程、视图、Composer"]
        AppServerClient["AppServerClient<br/>请求、响应、通知、超时"]
        EventCoordinator["事件协调器<br/>thread / turn / item / office 通知"]
        OfficeUI["Office UI<br/>群聊、成员、任务、记忆"]
        PlatformClient["Agent Platform Client<br/>认证、目录、下载"]
    end

    subgraph Transport["App-server 接入层"]
        Connection["WebSocket / stdio / Unix Socket"]
        RpcGate["Initialize、RPC Gate<br/>限流、反压、序列化"]
        Router["MessageProcessor<br/>JSON-RPC 路由与协调"]
        Outgoing["Outgoing Message<br/>响应、通知、Server Request"]
    end

    subgraph DomainLayer["App-server 领域层"]
        ThreadDomain["Thread / Turn 生命周期"]
        OfficeDomain["Office Domain<br/>创建、消息、运行、成员、审批、产物、记忆"]
        AgentPlatformDomain["Agent Platform 会话代理"]
        AutomationDomain["Automation / Verification"]
        ResourceDomain["Agent / Skill / MCP / Knowledge / Plugin"]
        CommandDomain["Command / FS / Git / PTY"]
    end

    subgraph OfficeTeamRuntime["当前 Office Team Runtime"]
        Leader["Leader / Supervisor<br/>Office Main Thread"]
        ContextBuilder["有界上下文构建<br/>Prompt Budget + Context Policy"]
        Scheduler["进程内调度器<br/>Claim、自动委派、验证、Re-plan"]
        Reducer["状态归并器<br/>结果、证据、风险、产物、来源"]
        Recovery["恢复与修复<br/>History Recovery、Completion Monitor、Runtime Repair"]
        MemberA["成员私有 Runtime Thread A"]
        MemberB["成员私有 Runtime Thread B"]
        AutomationThread["Automation Verification Thread"]
    end

    subgraph CoreRuntime["CrewON Core Runtime"]
        ThreadManager["Thread Manager"]
        Context["模型上下文<br/>增量历史 + 有界 Context Fragment"]
        AgentLoop["Agent Loop<br/>推理、工具调用、响应"]
        Tools["工具系统<br/>Shell、FS、Git、Skill、MCP、Apps"]
        Safety["权限、审批、沙箱"]
        AgentControl["Multi-agent AgentControl<br/>spawn / followup / message / wait"]
    end

    subgraph State["状态与持久化"]
        Rollout[("Thread Rollout<br/>权威会话历史")]
        OfficeJSON[(".crewon/offices/*.json<br/>Office 共享账本")]
        RunIndex[(".crewon/office-runs<br/>index + scheduler")]
        MemoryIndex[(".crewon/office-memory/index.json<br/>受治理长期记忆")]
        AgentConfig[("Agent / Automation 配置")]
        WorkspaceIndex[("$CREWON_HOME/office-scheduler<br/>workspace index")]
    end

    UI --> AppState
    AppState --> AppServerClient
    AppState --> PlatformClient
    AppServerClient --> Connection
    Connection --> RpcGate
    RpcGate --> Router
    Router --> Outgoing
    Outgoing --> EventCoordinator
    EventCoordinator --> OfficeUI
    EventCoordinator --> AppState

    Router --> ThreadDomain
    Router --> OfficeDomain
    Router --> AgentPlatformDomain
    Router --> AutomationDomain
    Router --> ResourceDomain
    Router --> CommandDomain

    OfficeDomain --> Leader
    Leader --> ContextBuilder
    ContextBuilder --> ThreadDomain
    ThreadDomain --> ThreadManager

    Scheduler --> MemberA
    Scheduler --> MemberB
    Scheduler --> AutomationThread
    Scheduler -->|"Review 未通过且预算允许"| Leader

    MemberA --> ThreadManager
    MemberB --> ThreadManager
    AutomationThread --> ThreadManager

    ThreadManager --> Context
    Context --> AgentLoop
    AgentLoop --> Tools
    AgentLoop --> Safety
    AgentLoop --> AgentControl

    AgentLoop --> Rollout
    OfficeDomain --> OfficeJSON
    Scheduler --> RunIndex
    ContextBuilder --> MemoryIndex
    ResourceDomain --> AgentConfig
    Recovery --> WorkspaceIndex

    Rollout --> Recovery
    OfficeJSON --> Recovery
    RunIndex --> Recovery
    AgentConfig --> Recovery
    Recovery --> Scheduler

    AgentLoop --> Reducer
    Reducer --> OfficeJSON
    Reducer --> MemoryIndex
    Reducer --> Outgoing
```

当前实现坚持两个重要边界：

1. Office 不创建第二套模型循环，真实执行继续复用 Thread、Turn、Agent Loop、工具、审批和沙箱。
2. Office JSON 是有界共享账本，不是完整聊天记录；Leader 和成员私有线程的 Rollout 才是权威会话历史。

当前图用于说明事实，不代表旧 Office JSON、前端 Agent Platform 直连或 one-shot 会话代理应进入未来架构。未来实现不会围绕这些路径新增 Facade 或双写。

## 二、当前核心功能执行流程

### 2.1 当前统一任务入口与执行分支

```mermaid
flowchart TB
    Start["用户在统一 Composer 输入任务"]
    Draft["附加工作空间、文件、知识、Skill、MCP<br/>选择 Scene 与执行主体"]
    Validate["前端预检<br/>资源可用性、工作空间、权限提示"]
    Submit["提交到 app-server"]
    Target{"服务端解析执行主体"}

    Single["CrewON / 本地单 Agent"]
    Cloud["Agent Platform 云 Agent"]
    Office["Office 群聊与 Leader"]
    Unsupported["协作流 / 专家团<br/>当前真实 Runtime 未接入"]

    SingleThread["thread/start 或 thread/resume"]
    SingleTurn["turn/start"]
    CoreLoop["Core Agent Loop<br/>模型、工具、审批、沙箱"]
    SingleResult["Turn 通知、产物、Rollout"]

    CloudStart["agentPlatform/chat/start"]
    CloudSSE["Agent Platform Open API Agent<br/>SSE 执行"]
    CloudHistory["本地派生会话历史<br/>与 Core 上下文隔离"]

    OfficeMessage["office/message/submit<br/>保留群聊和 @ 语义"]
    OfficeRun["office/run<br/>创建 Leader Run"]
    LeaderTurn["Office Main Thread turn/start"]
    Dispatch["调度安全的成员委派与验证"]
    MemberTurns["成员私有 Thread / Turn"]
    Reduce["归并有界摘要、证据、风险与产物"]
    OfficeUpdate["office/run/updated<br/>刷新群聊和共享账本"]

    Start --> Draft --> Validate --> Submit --> Target
    Target -->|"single"| Single
    Target -->|"external agent"| Cloud
    Target -->|"office"| Office
    Target -->|"尚未实现"| Unsupported

    Single --> SingleThread --> SingleTurn --> CoreLoop --> SingleResult

    Cloud --> CloudStart --> CloudSSE --> CloudHistory --> SingleResult

    Office --> OfficeMessage --> OfficeRun --> LeaderTurn
    LeaderTurn --> Dispatch --> MemberTurns --> Reduce --> OfficeUpdate
    OfficeUpdate -->|"仍需执行"| Dispatch
    OfficeUpdate -->|"Review 需要修正"| LeaderTurn
    OfficeUpdate -->|"通过或阻塞"| SingleResult
```

### 2.2 当前上下文组装与压缩流程

```mermaid
flowchart LR
    Request["当前用户请求"]
    Shared["共享运行上下文<br/>目标、任务、委派、证据、风险、产物"]
    Private["成员私有上下文<br/>成员自己的 Thread Rollout"]
    Memory["长期记忆检索<br/>仅 accepted、数量和长度有硬上限"]
    Policy{"成员 Context Policy"}
    SharedDigest["sharedDigest<br/>注入有界共享摘要"]
    ForkLastN["forkLastN<br/>摘要 + 少量最近群聊"]
    Isolated["isolated<br/>不注入共享摘要"]
    Prompt["最终模型 Prompt<br/>有硬预算的组合上下文"]
    Rollout["权威 Rollout<br/>历史增量追加，不重写"]

    Request --> Prompt
    Shared --> Policy
    Policy --> SharedDigest --> Prompt
    Policy --> ForkLastN --> Prompt
    Policy --> Isolated --> Prompt
    Private -->|"由成员线程自身续接"| Prompt
    Memory --> Prompt
    Prompt --> Rollout
```

当前所谓“上下文压缩”不是反复重写完整历史，而是：

- 保留 Thread Rollout 的增量历史。
- 为每次运行构建有硬上限的共享摘要。
- 按成员策略决定是否加入最近群聊片段。
- 从长期记忆中只检索已接受、与当前任务相关的少量事实。
- 长内容通过文件、产物或证据引用传递，不复制到 Office JSON。

## 三、当前办公室执行泳道图

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant UI as CrewON UI
    participant Office as App-server Office Domain
    participant Leader as Leader Main Thread
    participant Scheduler as Office Scheduler
    participant Member as Member Private Thread
    participant Core as Core / Model / Tools
    participant Store as Office + Rollout Storage

    User->>UI: 在办公室群聊输入目标或 @成员任务
    UI->>Office: office/message/submit 或 office/run
    Office->>Store: 保存规范化消息与 queued Run
    Office->>Leader: turn/start 有界 Office Prompt
    Leader->>Core: 执行 Leader Agent Loop
    Core-->>Leader: 计划、委派、验收条件、风险
    Leader-->>Office: terminal Turn / officeUpdate
    Office->>Store: Reducer 写入共享账本与调度意图
    Office->>Scheduler: 触发安全调度 tick

    loop 仍有安全可执行的成员任务
        Scheduler->>Store: Claim 下一条委派，防止重复执行
        Scheduler->>Member: 在成员私有 Thread 上 turn/start
        Member->>Core: 使用成员身份、私有历史和有界共享摘要
        Core-->>Member: 结构化结果、工具证据、产物引用
        Member-->>Office: terminal Turn
        Office->>Store: 归并摘要、证据、风险、产物和来源
        Office->>Scheduler: 继续下一次调度 tick
    end

    opt 存在自动化验证
        Scheduler->>Core: 启动 Automation Verification Turn
        Core-->>Office: 返回真实验证证据
        Office->>Store: 更新 verification 与 review
    end

    alt Review 通过
        Office-->>UI: office/run/updated completed
        UI-->>User: 显示群聊回复、任务结果和产物
    else Review 未通过且仍有重试预算
        Scheduler->>Leader: 启动有界 Re-plan Turn
        Leader->>Core: 根据失败验收、风险和证据修正
    else 需要人工审批或高风险决策
        Office-->>UI: office/run/updated blocked / needsReview
        UI-->>User: 请求确认、审批或补充信息
    end
```

## 四、当前能力完成度

| 能力                    | 当前状态 | 当前边界                                                 |
| ----------------------- | -------- | -------------------------------------------------------- |
| 单 Agent 会话           | 已接入   | 正常 Thread / Turn / Item Runtime                        |
| Agent Platform 云 Agent | 已接入   | app-server 代理执行，本地保存有界派生历史                |
| Office                  | 已接入   | 群聊、Leader、成员委派、审批、产物、记忆、恢复           |
| Office 自动恢复         | 已接入   | app-server 运行时可恢复；进程停止期间模型执行不会继续    |
| 协作流                  | 未接入   | 前端入口禁用，没有真实列表、创建和运行 API               |
| 专家团                  | 未接入   | 定位为单聊 Leader 接口，但没有真实定义和后台成员 Runtime |
| 独立 Durable Worker     | 未接入   | Scheduler 仍由 app-server 进程驱动                       |

## 五、未来目标总体架构

### 5.1 未来跨服务目标架构

```mermaid
flowchart TB
    subgraph Clients["多端客户端"]
        PC["PC / Tauri"]
        Web["Web"]
        Mobile["Mobile"]
        SharedUI["统一任务、会话、办公室、协作流、专家团 UI"]
        PC --> SharedUI
        Web --> SharedUI
        Mobile --> SharedUI
    end

    subgraph ControlPlane["CrewON 控制与领域层"]
        AppServerV2["Local app-server v2<br/>JSON-RPC + localNode authority"]
        CloudTaskAPI["Cloud Task API<br/>Cloud transport + cloudControl authority"]
        ContractResolver["Task Contract Resolver<br/>Scene × Mode × Target × Policy"]
        ResourceFederation["Resource Federation<br/>Provider、Binding、Version"]
        ProviderAdapters["Provider Adapter Registry<br/>Capability、Auth、Event Mapping"]
        ContextAssembler["Context Assembler<br/>Typed Fragment、预算、检索、审计"]
        PolicyGate["Policy / Approval Gate<br/>本地权限、外部动作、人工确认"]
        ArtifactService["Artifact Manifest<br/>产物、版本、来源、校验指纹"]
    end

    subgraph OrchestrationPlane["统一任务编排领域"]
        LocalKernel["Local Task Kernel<br/>SQLite、Lease、恢复"]
        CloudKernel["Cloud Task Orchestrator<br/>Postgres、Queue、Node Lease"]
        Strategy["封闭 StrategyKind<br/>exhaustive match"]
        SingleStrategy["Single Strategy"]
        OfficeStrategy["Office Strategy<br/>可见群聊与 @成员"]
        WorkflowStrategy["Workflow Strategy<br/>DAG、阶段、Gate"]
        ExpertsStrategy["Experts Strategy<br/>Leader 单聊、隐藏内部协作"]
        Verification["Verification / Review Engine<br/>验收、证据、风险、停止条件"]
    end

    subgraph LocalExecution["本地执行平面"]
        LocalWorker["Local Worker Executor"]
        CoreRuntime["CrewON Core<br/>Agent Loop、Tools、MCP、Sandbox"]
        Workspace["Workspace / Git / Files / Shell"]
    end

    subgraph AgentPlatform["Agent Platform Provider"]
        APCatalog["Auth + Agent / Skill / MCP / KB / Workflow Catalog"]
        APProviderRun["Durable Provider Run<br/>幂等、事件、取消、恢复"]
        APRuntime["Cloud Agent / Skill / MCP / KB / Workflow Runtime"]
    end

    subgraph External["其他外部提供方"]
        OtherProviders["Other Agent / MCP / SaaS Providers"]
        ModelProvider["Model Provider"]
        MCPApps["MCP / Apps / Connectors"]
    end

    subgraph DataPlane["持久化与事件平面"]
        LocalState[("crewon-state / state_5.sqlite<br/>Task、Event、Lease、Outbox")]
        CloudState[("Cloud Task / Event / Queue / Outbox")]
        RolloutStore[("Thread Rollout Store")]
        ArtifactStore[("Artifact / Object Store")]
        MemoryStore[("Governed Memory + Retrieval Index")]
        Observability["Trace / Metrics / Audit Log"]
    end

    SharedUI -->|"localNode task"| AppServerV2
    SharedUI -->|"cloudControl task"| CloudTaskAPI
    AppServerV2 --> ContractResolver
    CloudTaskAPI --> ContractResolver
    ContractResolver --> ResourceFederation
    ContractResolver --> ContextAssembler
    ContractResolver --> PolicyGate
    AppServerV2 --> LocalKernel
    CloudTaskAPI --> CloudKernel
    LocalKernel --> Strategy
    CloudKernel --> Strategy
    Strategy --> SingleStrategy
    Strategy --> OfficeStrategy
    Strategy --> WorkflowStrategy
    Strategy --> ExpertsStrategy
    LocalKernel --> Verification
    CloudKernel --> Verification

    LocalKernel --> LocalWorker --> CoreRuntime
    CoreRuntime --> ModelProvider
    CoreRuntime --> MCPApps
    CoreRuntime --> Workspace
    LocalKernel --> ProviderAdapters
    CloudKernel --> ProviderAdapters
    ResourceFederation --> APCatalog
    ResourceFederation --> ProviderAdapters
    ProviderAdapters --> APProviderRun --> APRuntime
    ProviderAdapters --> OtherProviders

    LocalKernel --> LocalState
    CloudKernel --> CloudState
    CoreRuntime --> RolloutStore
    ContextAssembler --> MemoryStore
    ArtifactService --> ArtifactStore
    Verification --> ArtifactService

    AppServerV2 --> Observability
    CloudTaskAPI --> Observability
    LocalKernel --> Observability
    CloudKernel --> Observability
    CoreRuntime --> Observability
    LocalState --> AppServerV2 --> SharedUI
    CloudState --> CloudTaskAPI --> SharedUI
```

未来目标不是拆出多套 Agent 引擎，而是形成三层稳定边界：

1. Local 与 Cloud 共享领域契约和 Strategy，但分别实例化 Identity、Workspace、Context、Policy 和 Authority；单个 Task 两侧不双写。
2. 控制面负责 API、身份、契约、资源、凭据、上下文、权限和审计；编排内核负责状态机、恢复、重试和验证。
3. Local Worker 复用 CrewON Core；Cloud Worker 通过 Provider Adapter 调用 Agent Platform Durable Run，不复制模型循环。
4. State 只通过鉴权后的 app-server/Cloud Task API 和事件协议到达 UI，数据存储不直接连接客户端。

### 5.2 未来本服务内部模块设计

```mermaid
flowchart LR
    Request["Task Request"]
    Identity["RequestIdentity<br/>Tenant、Space、Actor"]
    Workspace["WorkspaceRegistry<br/>Key、Node、Permission"]
    Resource["ResourceBindingResolver"]
    Credential["CredentialRef Resolver"]
    Resolver["TaskContractResolver"]
    Contract["ResolvedTaskContract<br/>scene、mode、target、workspace、policy、deliverable"]
    ContextAssembler["ContextAssembler<br/>有界 Typed Fragments"]
    Policy["Policy + ApprovalDigest"]
    Orchestrator["TaskOrchestrator"]
    EventReducer["Canonical Event Reducer"]
    TaskStorePort["TaskStore Port"]
    StateAdapter["TaskStateStoreAdapter"]
    StateRuntime["crewon-state<br/>single SQLite lifecycle"]
    ProviderPort["Provider Ports"]
    ProviderAdapter["Agent Platform Adapter"]
    Audit["Audit / Trace / Retention"]
    Result["Task Snapshot + Artifact Manifest"]

    subgraph Strategies["封闭 StrategyKind + exhaustive match"]
        Single["DurableSingleStrategy"]
        Office["OfficeExecutionStrategy"]
        Workflow["WorkflowExecutionStrategy"]
        Experts["ExpertsExecutionStrategy"]
    end

    subgraph CommonRuntime["共享运行能力"]
        ThreadRuntime["Thread / Turn Runtime"]
        ToolRuntime["Tool / MCP / Skill Runtime"]
        PermissionRuntime["Permission / Approval / Sandbox"]
        VerificationRuntime["Verification / Review"]
        ArtifactRuntime["Artifact / Evidence"]
        MemoryRuntime["Governed Memory Retrieval"]
    end

    Request --> Identity
    Identity --> Workspace --> Resolver
    Identity --> Credential --> Resource --> Resolver
    Resolver --> Contract
    Contract --> ContextAssembler --> Policy --> Orchestrator
    Orchestrator --> Single
    Orchestrator --> Office
    Orchestrator --> Workflow
    Orchestrator --> Experts

    Single --> ThreadRuntime
    Office --> ThreadRuntime
    Workflow --> ThreadRuntime
    Experts --> ThreadRuntime

    ThreadRuntime --> ToolRuntime
    ThreadRuntime --> PermissionRuntime
    ThreadRuntime --> VerificationRuntime
    ThreadRuntime --> ArtifactRuntime
    ContextAssembler --> MemoryRuntime

    ThreadRuntime --> EventReducer
    ToolRuntime --> EventReducer
    PermissionRuntime --> EventReducer
    VerificationRuntime --> EventReducer
    ArtifactRuntime --> EventReducer
    EventReducer --> Result
    Result --> Audit
    Orchestrator --> TaskStorePort --> StateAdapter --> StateRuntime
    Orchestrator --> ProviderPort --> ProviderAdapter
```

建议通过稳定接口降低耦合：

- `TaskContractResolver` 只负责把用户选择和服务端 Registry 解析成不可变任务契约。
- `RequestIdentity`、Workspace Root、Credential owner 和 Actor 全部由服务端解析，不能信任 Client Params。
- `TaskOrchestrator` 只协调状态，不直接实现模型循环。
- 第一版使用封闭 Strategy enum；普通本地单聊保留 Thread/Turn，但复用相同 Identity、Workspace、Resource、Context、Policy、Artifact 和 Audit。
- 所有运行变化进入统一事件模型，再由 Reducer 生成客户端快照。
- 长内容保存在 Rollout 或 Artifact Store，状态快照只保存摘要、引用、哈希和来源。
- 本地 Task 复用 `crewon-state` 的数据库生命周期；领域 Port 由 app-server Adapter 映射，不让 `crewon-state` 依赖 Task Runtime。
- Provider Adapter 只实现 Provider 协议，不依赖 Task Runtime；Provider Event 到 Task Event 的映射留在组合层。

## 六、未来核心功能执行流程

### 6.1 未来统一任务执行流程

```mermaid
flowchart TB
    Input["统一 Composer 提交任务"]
    Resolve["服务端解析 Task Contract<br/>Scene × Mode × Execution Target × Policy"]
    Preflight{"真实能力预检"}
    Repair["提示补充上下文、授权或切换执行主体"]
    Context["构建有界上下文<br/>Thread History + Shared Digest + Memory + Resources"]
    Strategy{"选择执行策略"}

    Single["Single<br/>一个主 Agent 完成"]
    Office["Office<br/>群聊可见、Leader 可 @成员"]
    Workflow["Workflow<br/>确定性 DAG、阶段和 Gate"]
    Experts["Experts<br/>用户只与 Leader 单聊"]

    Schedule["Durable Scheduler<br/>Claim、Lease、并发、重试、恢复"]
    Workers["独立 Worker Thread / Turn"]
    Gate{"权限、审批或外部动作 Gate"}
    Execute["模型与工具执行"]
    Observe["采集真实事件<br/>Tool、File、Diff、Test、Approval、Artifact"]
    Reduce["Reducer 生成状态、证据、风险和来源"]
    Verify{"验收与停止条件"}
    Replan["Leader / Workflow 根据失败证据 Re-plan"]
    Blocked["等待用户、资源或外部状态"]
    Complete["完成<br/>Transcript + Artifact Manifest + Verified Evidence"]
    MemoryReview["生成 Memory Candidate<br/>用户或策略审核后才可 accepted"]

    Input --> Resolve --> Preflight
    Preflight -->|"缺少 required 能力"| Repair
    Repair --> Resolve
    Preflight -->|"通过"| Context --> Strategy

    Strategy --> Single
    Strategy --> Office
    Strategy --> Workflow
    Strategy --> Experts

    Single --> Schedule
    Office --> Schedule
    Workflow --> Schedule
    Experts --> Schedule

    Schedule --> Workers --> Gate
    Gate -->|"允许"| Execute --> Observe --> Reduce --> Verify
    Gate -->|"需人工处理"| Blocked

    Verify -->|"通过"| Complete
    Verify -->|"可修正且预算允许"| Replan --> Schedule
    Verify -->|"高风险、无能力或无预算"| Blocked
    Complete --> MemoryReview
```

### 6.2 四种执行模式的目标差异

| 模式     | 用户界面    | 编排方式            | 成员可见性            | 典型 Gate                  | 最终收敛者               |
| -------- | ----------- | ------------------- | --------------------- | -------------------------- | ------------------------ |
| Single   | 单聊        | 单主线程            | 无成员概念            | 权限与外部动作             | 主 Agent                 |
| Office   | 群聊        | Leader 动态委派     | 成员、@任务和回复可见 | 审批、高风险委派、外部动作 | Leader                   |
| Workflow | 流程运行页  | 确定性 DAG / 状态机 | 按节点展示执行者      | 节点 Gate、人工确认、验收  | Workflow Reducer / Owner |
| Experts  | Leader 单聊 | Leader 隐式分派专家 | 内部成员默认隐藏      | 高风险结论、外部动作       | Leader                   |

## 七、未来跨服务执行泳道图

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant Client as CrewON Client
    participant API as Local app-server / Cloud Task API
    participant Resolver as Contract + Context Resolver
    participant Scheduler as Authority Task Kernel
    participant Gate as Policy / Approval Gate
    participant Local as Local Worker + CrewON Core
    participant Adapter as Provider Adapter
    participant Provider as Agent Platform Provider Run
    participant Data as State / Event / Rollout / Artifact

    User->>Client: 输入任务、资源和执行主体
    Client->>API: 创建任务
    API->>Resolver: 解析 Scene、Mode、Target、Policy
    Resolver->>Data: 读取资源、历史、记忆与权限配置
    Data-->>Resolver: 返回有界引用和能力状态

    alt required 上下文或能力缺失
        Resolver-->>API: preflight blocked + 修复动作
        API-->>Client: 提示补充、授权或切换目标
        Client-->>User: 显示可执行修复路径
    else 预检通过
        Resolver-->>API: ResolvedTaskContract + Context Bundle
        API->>Data: 原子保存 Task 与初始 Event
        API->>Scheduler: enqueue task
        Scheduler->>Data: Claim Lease

        loop 直到验收通过、阻塞或预算耗尽
            Scheduler->>Gate: 校验 Worker、资源、上下文与外部动作

            alt 自动允许
                Gate-->>Scheduler: allow
            else 需要人工审批
                Gate->>Data: 写入 approvalRequired Event
                Data-->>Client: 推送审批状态
                Client->>User: 请求确认
                User->>Client: 批准或拒绝
                Client->>API: approval/decide
                API->>Gate: 提交决定
                Gate-->>Scheduler: allow / deny
            end

            alt executionLocation = local
                Scheduler->>Local: WorkerRequest + Lease/Fencing
                Local-->>Scheduler: Core Turn 事件、结果、Artifact Ref
            else executionLocation = provider
                Scheduler->>Adapter: WorkerRequest + CredentialRef
                Adapter->>Provider: 幂等 start/read/events/cancel
                Provider-->>Adapter: Provider Events + Cursor
                Adapter-->>Scheduler: 规范化 Worker Events
            end

            Scheduler->>Data: 原子 Append Event + Snapshot + Outbox
            Data-->>Client: 推送真实运行事件

            alt 验收通过
                Scheduler->>Data: 标记 completed
            else 可安全修正
                Scheduler->>Data: 写入 replan / retry intent
            else 需要用户或外部状态
                Scheduler->>Data: 标记 blocked
            end
        end

        Data-->>Client: 最终快照、Transcript 和 Artifact Manifest
        Client-->>User: 展示结果、证据、风险和后续动作
    end
```

## 八、未来 Office / Workflow / Experts 内部协作泳道

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant Surface as Office群聊 / Workflow页 / Experts单聊
    participant Leader as Leader或Workflow Owner
    participant Orchestrator as Durable Orchestrator
    participant WorkerA as Worker A
    participant WorkerB as Worker B
    participant Verifier as Verification Worker
    participant Store as Event与Artifact Store

    User->>Surface: 提交目标
    Surface->>Leader: 创建主任务
    Leader->>Store: 保存目标、验收条件和权限边界
    Leader->>Orchestrator: 提交结构化执行计划

    par 可并行的独立任务
        Orchestrator->>WorkerA: 最小上下文 + 最小工具 + 输出契约
        WorkerA->>Store: 事件、结果、产物引用
    and
        Orchestrator->>WorkerB: 最小上下文 + 最小工具 + 输出契约
        WorkerB->>Store: 事件、结果、产物引用
    end

    Orchestrator->>Leader: 返回有界摘要、证据和未解决问题
    Leader->>Verifier: 请求独立验证
    Verifier->>Store: 写入测试、审阅或业务验收证据
    Store-->>Leader: 返回证据与风险状态

    alt 验收通过
        Leader->>Store: 收敛最终结果和 Artifact Manifest
        Leader-->>Surface: 输出最终结果
        Surface-->>User: 展示可验证交付物
    else 可以修正
        Leader->>Orchestrator: 根据失败证据创建下一轮子任务
    else 需要人工决策
        Leader-->>Surface: 请求审批、选择或补充信息
        Surface-->>User: 展示明确阻塞原因
    end

    Note over Surface,Leader: Office 展示成员与 @协作；Experts 隐藏内部成员；Workflow 展示节点与 Gate
```

## 九、推荐演进顺序

| 阶段                       | 目标                         | 关键交付                                                              | 不做的事情                                      |
| -------------------------- | ---------------------------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| P0 Platform Contract       | 冻结完整中台安全与领域边界   | Identity/Tenant/Actor、Workspace、Credential、Resource、Event、Error  | 不加临时 API、可伪造身份或新执行入口            |
| P1 Local Platform Kernel   | 建立所有消费者共享的本地内核 | app-server v2、Registry、Context、Policy、Artifact、Audit、Task/State | 不复制认证、Context、沙箱或数据库生命周期       |
| P2 Provider Control Plane  | 建立安全的外部资源和执行控制 | Provider Connection、Catalog、CredentialRef、Durable Run、Adapter     | 不包装 one-shot、不让 UI 保存 Secret 或执行资源 |
| P3 First Consumers         | 用真实消费者验证中台         | 普通 Single 共享能力、Durable Cloud Agent、Office fence/迁移          | 不同时铺开 Workflow/Experts/Cloud Authority     |
| P4 Collaboration Consumers | 扩展协作消费者               | Workflow、Experts、Automation/Schedule 复用 Task/Policy/Artifact      | 不复制 Office 状态机或专用安全逻辑              |
| P5 Cloud Authority         | 支持跨设备与后台执行         | Cloud Task Store、Queue、Node Lease、事件流、混合本地/云 Worker       | 无真实需求证据前不创建空服务或空表              |
| P6 Secure Bridge           | 最小化开放本地能力           | Context Export、Tool Bridge、Action Digest、逐次审批和跨边界审计      | 不上传 Workspace、不开放任意 Shell              |

## 十、架构决策摘要

1. Scene 和执行主体继续保持正交，客户端不能通过布尔值伪造 Team Runtime。
2. 单聊工作空间与 Office 群聊工作空间保持独立，Experts 继续属于单聊边界。
3. Office、Workflow、Experts 共享 Thread、Turn、Tool、MCP、Approval、Sandbox 和 Artifact Runtime。
4. Office 使用可见群聊与成员委派；Workflow 使用确定性节点和 Gate；Experts 使用 Leader 单聊与隐藏内部协作。
5. 上下文历史增量追加，不由编排器或子 Agent 重写。
6. Worker 上下文、单项返回、检索记忆和共享摘要都有硬上限。
7. 所有可见运行状态来自真实事件，不生成假阶段、假百分比或假完成消息。
8. 外部动作和高风险操作必须经过服务端 Policy Gate，不能依赖前端提示词约束。
9. Actor、Tenant、Space、Workspace Root、Credential owner 和成员身份全部由服务端解析。
10. 一个 Aggregate 任一时刻只有一个可写权威；Office 迁移必须 quiesce 活动旧 Run，禁止双写与 silent fallback。
11. 本地 Task 复用 `crewon-state`，Cloud Task 使用云 Store；二者共享领域契约，不共享物理数据库或运行时权威。
12. 普通 Single 不强制迁入 Task Runtime，但必须使用完整中台的 Identity、Workspace、Resource、Context、Policy、Artifact 和 Audit。
13. Provider Run 未具备全接口租户授权、幂等、续读、取消和恢复前，不迁移 Cloud Agent。
14. 即使未来拆出执行平面，也不实现第二套模型循环：本地继续复用 CrewON Core，云端复用 Agent Platform Runtime。
