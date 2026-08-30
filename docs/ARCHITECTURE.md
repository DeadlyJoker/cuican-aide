# ARCHITECTURE

# CatDesk-OSS 架构设计文档

> 一个基于 Electron + React 的 **AI Agent 桌面工作台**（AI Agent Desktop Workbench）的开源内核。
>
> 本文档面向：想理解整体设计的新成员、要做 Fork/定制（distro）的团队、以及需要评估技术方案的架构评审者。

---

## 目录

- [一、产品定位与设计目标](#一产品定位与设计目标)
- [二、技术选型与决策依据](#二技术选型与决策依据)
- [三、整体架构总览](#三整体架构总览)
- [四、进程模型与窗口拓扑](#四进程模型与窗口拓扑)
- [五、主进程分层架构（L0–L3）](#五主进程分层架构l0l3)
- [六、Bridge 层：渲染进程 ↔ 主进程通信契约](#六bridge-层渲染进程--主进程通信契约)
- [七、渲染进程架构](#七渲染进程架构)
- [八、Local / Cloud 双运行时（Dual-Runtime）架构](#八local--cloud-双运行时dual-runtime架构)
- [九、Slots 扩展点机制：OSS / Distro 的分离之道](#九slots-扩展点机制oss--distro-的分离之道)
- [十、Provider Registry：主进程内的依赖倒置](#十provider-registry主进程内的依赖倒置)
- [十一、扩展生态：Plugin / Skill / MCP / Command / Subagent](#十一扩展生态plugin--skill--mcp--command--subagent)
- [十二、核心业务子系统详解](#十二核心业务子系统详解)
- [十三、数据与存储架构](#十三数据与存储架构)
- [十四、可观测性、诊断与容错](#十四可观测性诊断与容错)
- [十五、安全设计](#十五安全设计)
- [十六、构建、打包与发布](#十六构建打包与发布)
- [十七、测试策略](#十七测试策略)
- [十八、架构权衡（Trade-offs）与演进方向](#十八架构权衡trade-offs与演进方向)

---

## 一、产品定位与设计目标

### 1.1 产品是什么

CatDesk 是一个**桌面级 AI Agent 工作台**。它不是"套壳聊天框"，而是把 Agent 的完整工作循环（对话、执行、观察、产出）搬到桌面，并把桌面本身的能力（文件系统、终端、浏览器、剪贴板、全局快捷键、系统通知）作为 Agent 的工具集暴露出来。

核心能力面：

|能力域|说明|
| ------| ------------------------------------------------------------------------------------|
|**对话与 Agent 执行**|流式对话、多轮会话、SubAgent 子会话、工具调用可视化、失败重试与恢复|
|**工作区（Workspace）**|项目/会话双层组织、文件树、文件监听、产物（Artifact）追踪|
|**内嵌终端**|node-pty 驱动的真实 PTY，Agent 与用户共用|
|**内嵌浏览器**|WebContentsView 驱动的可编排浏览器，供 Agent 做网页操作与信息抓取|
|**文件预览**|Monaco 代码预览 + 图片/音视频原生播放 + Office/PDF 在线渲染|
|**扩展生态**|Plugin（容器）/ Skill（能力包）/ MCP Server / Slash Command / Subagent|
|**自动化（Automation）**|RRule 定时调度 + 事件触发，无人值守跑 Agent 任务|
|**多形态入口**|主窗口、Quick Chat（Raycast 式唤起）、Popout 独立会话窗、桌宠 Overlay、CLI、DeepLink|
|**语音输入**|原生键盘监听 Fn 键 Push-to-Talk + 流式 ASR|
|**云端协同**|本机作为 Channel 接入远端 Desk / 云端沙箱容器|

### 1.2 六个核心设计目标

这六个目标解释了后文几乎所有的架构决策：

**G1 — 可裁剪（Trimmable）**

> 任何一个 feature 目录被整体删除，其余系统仍能编译、启动、运行。

这是 OSS 开源内核的硬约束。`electron/services/feature/` 下每个子目录（`voice/`、`wenshu/`、`pet/`、`office/`…）都是独立可移除单元。

**G2 — 可 Fork 定制（Forkable via Distro）**

> 上游内核（OSS）与下游定制（distro）之间零 patch、零 fork 分叉。

通过 **Slots 文件影子覆盖（Shadow）**  机制实现：distro 提供同路径同名文件，构建时由 `distroResolvePlugin` 覆盖 OSS 默认实现。全仓 **70+ 个 **​ **​`*Slots.ts`​** 就是这套契约的落地。

**G3 — 双运行时同构（Local / Cloud Isomorphism）**

> 同一份 UI 代码，既能驱动本机 Agent 进程，也能驱动云端远程 Desk。

通过 `IXxxBridge` 接口 + `local*/cloud*` 双实现 + `runMode` 运行时分发达成。

**G4 — 防御式降级（Fail-Safe by Default）**

> 任何跨进程调用失败，都不允许让 UI 崩溃。

Bridge 层每个方法都是 `getElectronAPI()?.method?.() ?? <安全默认值>`。

**G5 — 单一事实源（Single Source of Truth）**

> 类型、配置、状态各有唯一定义处，禁止手写重复声明。

`window.electronAPI` 的类型直接 `typeof` 自 preload；`product.json` 是所有品牌/行为配置的唯一来源；`session.status` 是会话运行态的唯一来源。

**G6 — 可诊断（Observable）**

> 出问题时能从日志/指标/trace 定位，而不是靠复现。

分文件日志体系 + Owl/Raptor 指标 + CPU Profile / Heap Snapshot / Chromium Trace 的一键采集。

---

## 二、技术选型与决策依据

### 2.1 选型总表

|层次|技术|版本/形态|选择理由|被拒方案与原因|
| ----| -------------------------------------| ---------------------------------| -----------------------------------------------------------------------------------------------| -----------------------------------------------------------------------------------------------------------------------------------------------|
|**桌面容器**|Electron|ESM 主进程|需要 Node.js 全能力（child_process / PTY / FFI / 原生模块）+ Chromium 渲染 + 成熟的自动更新生态|**Tauri**：Rust 生态对 node-pty / koffi / better-sqlite3 这类既有 Node 原生依赖不友好，且 Agent SDK 是 Node 包；**纯 Web**：无法访问本地文件系统与终端，产品立不住|
|**UI 框架**|React 19|`StrictMode` + `createRoot`|团队熟悉度、并发特性（`useSyncExternalStore` 用于命令/快捷键注册表）、生态（Radix / dnd-kit / TanStack Virtual）|**Vue/Svelte**：团队既有 UI SDK（`@catpaw-ui/*`）是 React 组件库|
|**状态管理**|Zustand|单 store + slice 自注册|无 Provider 嵌套、选择器订阅粒度细、`useShallow` 控制 re-render、可在非组件层（service）直接 `getState()`|**Redux**：样板过重；**Context**：大 store 下重渲染不可控；**Jotai**：原子过多时启动编排（beforeInit/afterInit 顺序）难表达|
|**构建工具**|Vite + esbuild/SWC|`vite-env.d.ts` 可见|冷启动快、HMR 快、`isolatedModules` 保证类型导入被擦除|**Webpack**：Electron 多入口场景下配置与构建速度均劣|
|**语言**|TypeScript|`strict` + `isolatedModules`|跨进程契约必须靠类型锁死|—|
|**测试**|Vitest + Testing Library + happy-dom|168 个测试文件|与 Vite 共用配置与转换管线，零额外构建成本|**Jest**：需要独立 transform 配置，与 Vite 的 ESM/别名解析易漂移|
|**样式**|Tailwind CSS + CVA + `clsx`/`tailwind-merge`|`index.css` 为入口|原子化避免样式冲突；CVA 表达组件变体|**CSS-in-JS**：Electron 下运行时开销与 FOUC 问题|
|**无障碍组件**|Radix UI|锁定 `1.1.17`|无样式、可访问性达标、Portal 可控（配合 BrowserView overlay 隐藏）|**MUI/AntD**：样式侵入强，与 UI SDK 冲突|
|**编辑器**|Monaco + Lexical|Monaco 只读预览；Lexical 做输入框|Monaco 是 VSCode 同款，代码预览体验一致；Lexical 支持富文本 mention/slash 的可扩展节点模型|**CodeMirror**：与 VSCode 视觉差异大；**ProseMirror**：API 陡峭|
|**终端**|`@xterm/xterm` + `node-pty`|+ `addon-fit` / `addon-unicode11`|事实标准，性能与兼容性最佳|—|
|**本地数据库**|better-sqlite3|asarUnpack|同步 API 适合主进程消息存储；单文件易备份/迁移|**IndexedDB**：在渲染进程，主进程无法直接写；**LevelDB**：无 SQL 查询能力|
|**轻量配置存储**|electron-store|JSON|设置项这类小体量强一致数据用 JSON 更易调试/手改|—|
|**原生 FFI**|koffi|隔离在 utilityProcess|macOS 键盘 CGEvent Tap 监听（Fn 键 Push-to-Talk）|**N-API 自研插件**：需维护多平台编译产物|
|**日志**|electron-log + 自研多文件 WriteStream|`main/renderer/agent/conversations` 分文件|electron-log 负责 console hook 与轮转；自研流负责高频 agent 事件的零开销写入|单一 electron-log：高频 agent 事件会污染 main.log|
|**调度**|rrule|自动化定时任务|iCalendar RRule 是日程重复规则的工业标准|**node-cron**：无法表达"每月第二个周二"这类规则|
|**Schema 校验**|zod|plugin.json / marketplace.json|运行时校验 + `z.infer` 反推类型，杜绝类型与校验漂移|手写校验：必然与类型定义漂移|
|**打包**|electron-builder|`electron-builder.json`|三平台产物 + Electron Fuses + asarUnpack 的成熟支持|**electron-forge**：Fuses/差量更新的可控性弱|
|**包管理**|pnpm workspace|`pnpm-workspace.yaml`|硬链接节省磁盘、`overrides` 精确锁定传递依赖版本、`onlyBuiltDependencies` 白名单控制原生模块编译|**npm/yarn**：幽灵依赖导致打包体积失控|

### 2.2 几个关键选型的深层理由

#### 为什么主进程用 ESM 而不是 CJS

`electron/bootstrap.ts` 的注释给出了完整推理：ESM 的 `import` 是**提升并在模块体执行前解析**的。这意味着如果 Windows 上一次增量更新失败导致 `app.asar` 内某个包缺失，Node 会在**任何业务代码运行之前**抛出 `Cannot find package`——此时 `main.ts` 里的 `process.on('uncaughtException')` 根本来不及注册。

解法是引入一个只依赖 `electron` 和 Node 内置模块的**极小 bootstrap 入口**：

```
package.json "main" → bootstrap.ts
    │
    ├─ 1. 同步注册 uncaughtException 守卫       ← 此时依赖树尚未解析
    ├─ 2. import('./main')  动态导入            ← 依赖解析在此发生
    ├─ 3. 解析失败 → rejected promise → uncaughtException
    ├─ 4. 守卫识别 "corrupted-asar" 特征 → 友好中文弹窗 + 下载链接
    └─ 5. app.quit()
```

判定"asar 损坏"需要**同时满足**两个条件（避免误伤可选原生模块缺失）：

1. 错误码是 `ERR_MODULE_NOT_FOUND` / `MODULE_NOT_FOUND`，或消息含 `cannot find package/module`
2. 错误信息引用了 `app.asar`（且做了 Windows 反斜杠归一化）

`readProduct()` 还刻意**优先读取磁盘上非 asar 的 **​**​`product.json`​**（`resources/product.json`、`resources/app/product.json`），因为此刻 asar 本身可能就是坏的——不能让损坏的 asar 把下载地址也一起藏起来。

#### 为什么 koffi 要放进独立 utilityProcess

`keyboardHelperHost.ts` 说明得很清楚：koffi 的 FFI 同步调用与其内部 `~InstanceData` mutex 有卡死主进程事件循环的风险。隔离到 `utilityProcess` 后：

- 主进程事件循环**永远不会**被 FFI 阻塞
- 子进程死锁/崩溃时，主进程 `kill(pid)` 即可干净收割，不影响退出与更新重启
- 主进程侧不再需要 `koffi.reset()` / `stopSync` 那套脆弱的退出兜底

native 控制面（`startMonitor` / `stopMonitor` / `setWatcherInterval` / `setAppActive`）全部在子进程自治，只把**原始按键帧**经 `parentPort` 回传主进程。这是"**把不可控的第三方原生代码关进笼子**"的典型隔离设计。

#### 为什么用 pnpm `overrides` 锁死传递依赖

```yaml
overrides:
  '@catx/desk-channel-sdk': '0.1.69'
  '@catx/desk-channel-sdk-node>@catx/desk-channel-sdk': '0.1.69'   # 嵌套覆盖
  '@radix-ui/react-dialog': '1.1.17'
```

Radix 被锁定是因为 Dialog/Popover 的 Portal 行为变更会直接破坏 `useOverlayAutoHide`（Radix 弹层打开时必须隐藏 BrowserView overlay，否则原生视图会盖住弹层）。`desk-channel-sdk` 的嵌套覆盖是为了保证 node 版与 web 版 SDK 走**同一份协议定义**，避免协议漂移。

---

## 三、整体架构总览

### 3.1 五层分层视图

```
┌───────────────────────────────────────────────────────────────────────────┐
│  L4  Distro Layer（下游定制，不在 OSS 仓库内）                              │
│      通过 distroResolvePlugin 影子覆盖 70+ 个 *Slots.ts                     │
│      internal 租户 / external(CatX) 租户 / 私有化部署 …                     │
├───────────────────────────────────────────────────────────────────────────┤
│  L3  Feature Layer（可裁剪特性）        electron/services/feature/**        │
│      agent · automation · plugin · market(skills/mcp) · system · voice      │
│      media · office · wenshu · pet · deepLink · project · commands · ask    │
│      ★ 每个子目录独立可删，删除后其余不受影响                                │
├───────────────────────────────────────────────────────────────────────────┤
│  L2  Core Layer（业务内核，本 OSS 子集未包含源码，通过引用可见）              │
│      agent/agentService · agent/agentHostService · agent/sessionMessageStore│
│      browser/tabManager · browser/webContentsViewManager · terminal/ptyService│
│      persistence/conversationStore · ui-sdk-conversation/* · providerRegistry│
├───────────────────────────────────────────────────────────────────────────┤
│  L1  Platform Layer（平台能力）                                            │
│      storage/* · auth/* · api/* · lifecycle · telemetry · window · env      │
├───────────────────────────────────────────────────────────────────────────┤
│  L0  Base Layer（零服务依赖的基础设施）  electron/services/base/**          │
│      productService · dataPathService · logFileService                     │
│      clientUuidService · localFileProtocol · appIconPaths                  │
└───────────────────────────────────────────────────────────────────────────┘
```

**分层铁律**：依赖只能自上而下。L2 core **禁止** import L3 feature——这条约束正是 `ProviderRegistry`（第十节）存在的全部理由。

`feature/index.ts` 明确写出了这条契约：

```
Feature Layer (L3) — Specific Features (Trimmable)
Each subdirectory is independently removable without affecting others.
Fork teams: remove entire subdirectories as needed.
```

`base/index.ts` 同样：

```
Base Layer (L0) — Infrastructure
Zero service dependencies. Provides configuration, logging, and identity.
Fork teams: do not delete, may modify configuration values.
```

### 3.2 端到端数据流：一次用户提问

```
用户在 ChatInput 敲字并回车
   │
   ▼
[R] UiSdkChatInput → useUiSdkChatInputSubmission
   │   组装 message + attachments + mentions + contextItems
   ▼
[R] useConversationActions
   │   从 store 读 runMode，调 getAgentChannel(runMode)
   ▼
[R] IAgentChannel ── 分发 ────────────┬──────────────────────┐
   │                                  │                      │
   │  runMode = local                 │  runMode = cloud     │
   ▼                                  ▼                      │
localAgentChannel                cloudAgentChannel           │
   │  ① appendUserMessageBeforeSend      │  ① noop（远端回声上屏）│
   │     写占位 user message              │                      │
   │  ② bridge.agent.send()              │  ② bridge.cloudConversation.send()
   ▼                                     ▼                      │
[Bridge] window.electronAPI.sendAgentQuery   window.electronAPI.cloudConversation.send
   │                                     │                      │
   ▼ contextBridge / ipcRenderer.invoke  ▼                      │
┌──────────────────── 主进程 ─────────────────────────────────┐ │
│ [IPC] agentHandlers                 [IPC] cloudHandlers      │ │
│   │                                   │                      │ │
│   ▼                                   ▼                      │ │
│ core/agent/agentService          CloudConversationManager    │ │
│   │  ① aggregateClientConfig()        │  ① connection.conversation.sendMessage  (Pike RPC)
│   │     ← ProviderRegistry 汇聚        │  ② CloudSseStreamManager.ensureStream() (SSE)
│   │       plugin.enabledPlugins        │                      │ │
│   │       market.skills                │                      │ │
│   │  ② aggregateShellEnv()             │                      │ │
│   │     ← safeRoom JWT 等              │                      │ │
│   │  ③ spawn catpaw-cli (@catpaw/agent-sdk)                   │ │
│   ▼                                   │                      │ │
│ Agent 进程流式产出事件                  │                      │ │
│   │                                   │                      │ │
│   └──────────┬────────────────────────┘                      │ │
│              ▼                                               │ │
│      core/agent/sessionMessageStore（主进程持有会话真值）      │ │
│              │  节流合批 + 写 SQLite 持久化                    │ │
│              ▼                                               │ │
│      typedBroadcast → 所有订阅窗口                            │ │
└──────────────┬───────────────────────────────────────────────┘ │
               ▼                                                 │
[R] useBridgeEvent(bridge.agent.onEvent | onSessionMessagesChanged)◄┘
               │
               ▼
[R] useAgentEventHandler
   │  ① streamId → sessionId 归属校验（多窗口串扰防护）
   │  ② 跨窗口 CLI stream 认领
   │  ③ 事件分类：model_chunk / tool_call / ask_question / agent_error / agent_end
   │  ④ 指标上报（首 token 延迟、LLM API 耗时、失败率）
   ▼
[R] Zustand catDeskStore.updateSession({ status, messages, ... })
   │
   ▼
[R] ChatAreaV2 / @catpaw-ui/render-react 渲染
```

三个关键设计点：

1. **会话真值在主进程**。`sessionMessageStore` 是唯一事实源，渲染进程只是投影。这样 Popout 窗口、Quick Chat、桌宠 Overlay 天然共享同一份数据，无需窗口间同步消息内容。
2. **​`streamId → sessionId`​**​ ** 归属映射由 facade 持有**。多窗口/多会话并发时，每个事件必须校验归属，防止 A 会话的 token 流进 B 会话。
3. **Local 写占位 user message，Cloud 不写**。因为远端 `sendMessage` 返回真实 `messageId` 后会立刻经 SSE 回推，若本地也写占位就会出现双行。这个差异被**封装在 channel 实现内部**，UI 完全无感。

---

## 四、进程模型与窗口拓扑

### 4.1 进程清单

|进程|数量|职责|隔离动机|
| ----| ------------| -------------------------------------------------| ----------------------------------|
|**Main（主进程）**|1|服务编排、IPC 路由、窗口/生命周期管理、Agent 调度|—|
|**Renderer（渲染进程）**|N|全部 UI，按 hash 路由分化为不同"窗口角色"|Chromium 站点隔离|
|**Preload**|每窗口 1|`contextBridge` 暴露 `window.electronAPI`|上下文隔离，渲染层无 Node 权限|
|**Agent CLI 子进程**|每会话 1|`catpaw-cli` + `@catpaw/agent-sdk` 执行 Agent Loop|Agent 崩溃不拖垮宿主；可独立 kill|
|**agent-host 子进程**|0..1|Channel 插件、移动端配对、Pike 长连接|网络长连接与主进程解耦；可按 `product.json` 关闭|
|**keyboard-helper（utilityProcess）**|0..1 (macOS)|koffi + CGEvent Tap 键盘监听|**隔离 FFI 死锁风险**（见 2.2）|
|**PTY 子进程**|每终端 1|node-pty 真实 shell|—|
|**Wenshu SW 隐藏窗口**|0..1|Chrome 扩展 Service Worker 环境模拟|让原插件代码零修改运行|

### 4.2 窗口拓扑：Hash 路由驱动的"单 bundle 多形态"

**同一份 **​**​`index.html`​**​ ** + 同一份 JS bundle**，通过 `window.location.hash` 在模块加载期（而非运行期）决定窗口角色。`hashRouteConstants.ts` 在模块顶层就完成解析：

```ts
const _hashParts = window.location.hash.slice(1).split('?')
export const isQuickChatRoute   = _hashParts[0] === '/quickchat'
export const isPopoutRoute      = _hashParts[0] === '/popout'
export const isPetOverlayRoute  = _hashParts[0] === '/pet-overlay'
export const isMemoryDevToolsRoute = window.location.hash === '#/memory-devtools'
export const isDiagnosticsRoute    = window.location.hash === '#/diagnostics'
export const isTaskManagerRoute    = window.location.hash === '#/task-manager'
export const isDiffDemoRoute       = _hashParts[0] === '/diff-demo'
```

|路由|窗口形态|外壳|特点|
| --------| -------------------| ---------------------| ------------------------------|
|`#/`（默认）|主窗口|完整 `MainLayout` + 全部全局 hook|唯一挂载完整表面|
|`#/quickchat`|Raycast 式唤起窗|极简，强制 `light` 主题|预热常驻、轻量初始化|
|`#/popout?sessionId=`|独立会话窗|极简|会话内容与主窗口共享主进程真值|
|`#/pet-overlay`|桌宠悬浮层|完全透明、无 chrome|被动只读快照|
|`#/diagnostics`|性能诊断台|极简|—|
|`#/memory-devtools`|记忆调试|极简|—|
|`#/task-manager`|进程管理器|极简|—|
|`#/diff-demo`|渲染链路 A/B 对比页|极简|验证 legacy → ui-sdk 数据转换|

### 4.3 `MainWindowApp` 隔离：一个真实的性能修复

`App.tsx` 里有一段值得单独讲的设计。最初所有全局 hook 都挂在 `App` 顶层，结果导致**Quick Chat 预热常驻窗口的 CPU/内存持续偏高**——因为 `useBrowserViewEvents`、`useOverlayAutoHide`、`useFileWatchEvents`、`useAutoArchive`、toast、`useCrossWindowSync` 这些主窗口专属 hook 在 quickchat/popout 窗口里空跑。

React Hooks 规则不允许把 hook 放进条件分支，所以解法是**下沉到只在主窗口渲染的子组件边界**：

```tsx
function App() {
  // ... 所有窗口都需要的：i18n、主题、keybinding、跨窗口 todos/sandbox/CLI 同步

  if (isQuickChatRoute)   return <极简外壳 />
  if (isPopoutRoute || …) return <极简外壳 />
  if (isPetOverlayRoute)  return <透明外壳 />

  return <MainWindowApp isDark={isDark} />   // ← 主窗口专属 hook 全在这里面
}

function MainWindowApp({ isDark }) {
  useBrowserViewEvents(); useOverlayAutoHide(); useFileWatchEvents()
  useAutoArchive(); useWatermark(); useCloudAutoReconnect(); /* … */
  return <div className={`app ${isDark ? 'dark' : 'light'}`}>…</div>
}
```

**架构启示**：在多窗口共享 bundle 的架构下，"组件边界"是隔离副作用的最自然手段，比在每个 hook 内部加窗口守卫更清晰、更不易遗漏。

---

## 五、主进程分层架构（L0–L3）

### 5.1 L0 Base：零依赖基础设施

`base/index.ts` 只导出 5 组能力，且**不依赖任何其他 service**：

#### `productService` — VSCode `IProductService` 的等价物

这是整个"一套代码多个品牌"能力的基石。`product.json` 在模块初始化时被读入并**深度冻结**：

```ts
function deepFreeze<T extends Record<string, unknown>>(obj: T): Readonly<T> {
  Object.freeze(obj)
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value as Record<string, unknown>)
    }
  }
  return obj
}
const productConfiguration = deepFreeze(productJson) as IProductConfiguration
```

它提供了 **30+ 个具名 getter**，每个都带 OSS 安全默认值。这个"**带默认值的具名 getter**"模式非常关键——它保证给 `product.json` 新增字段时，**永远不会静默改变已有 build 的行为**：

```ts
// Agent 子系统
getAgentBackend()          // 'local-cli' | 'catx'，默认 local-cli
getAgentSdkSource()        // 默认 'CatPawDesk'
getEffectiveAgentSdkSource(isCloud)  // cloud 走独立 source 便于后端分桶
getAgentHostEnabled()      // 默认 true
getAgentEnableArtifacts()  // 默认 true
getAgentEnableGenerateImage()  // 默认 false（依赖美团内网图床）
getAgentEnableMemoryMcp()  // 默认 true

// 模型档位（distro 可路由到不同后端）
getAgentQueryDefaultModelId()   // 0   = Auto
getAgentQuerySafeRoomModelId()  // 10000 = 安全屋
getAgentQueryLiteModelId()      // 10001
getAgentQueryProModelId()       // 10002
getAgentQueryMaxModelId()       // 10003

// 存储 / 更新 / 打包
getRemoteStorageEnabled()   // 默认 false（本地 electron-store）
getWindowsUpdateMode()      // 'overlay' | 'mutex'
getWin32MutexName()         // 必须与 Inno Setup 脚本的 AppMutex 一致
getBundleDisplayName()      // 镜像 electron-builder 的 productFilename 推导规则
```

`getBundleDisplayName()` 的注释尤其体现工程严谨度——它必须精确复刻 electron-builder 内部 `productFilename = executableName ?? sanitizedProductName` 的推导链，否则 macOS 自更新会找不到 `.app` 包。

#### `dataPathService` — 全部路径的唯一出口

**杜绝任何地方硬编码 **​ **​`~/.catpaw/`​** 。所有路径都从 `product.json` 的 `dataFolderName` 派生。

最精妙的设计是 **账号 Scope 分片**：

```ts
export function getScopedDataFolderName(): string {
  return path.join(getDataFolderName(), dataPathScopeSlot.getActiveScopeSegment())
}
export function getUserDataDir(): string {
  return path.join(getRuntimeHome(), getScopedDataFolderName())
}
```

OSS 默认 `getActiveScopeSegment()` 返回空串，`path.join(home, '.catpaw', '')` 塌缩为 `~/.catpaw`——**字节级等同于历史行为**。而支持多账号的 distro 返回 `<uid>` / `anon`，自动把每个账号隔离到 `~/.meituan-catpaw/12345/` 子目录。

> **零成本抽象**：加了扩展点，但不用它时行为、路径、性能完全不变。这是"可 Fork"设计的黄金标准。

这个 scoped 路径同时被作为 `CATPAW_DIR` 传给 `catpaw-cli`，保证 **GUI 读写与 CLI 发现走同一棵账号目录树**。

还有一处细节：CLI 相关路径用 **​`cliFolderName`​** 而非 `dataFolderName`：

```ts
export function getCliFolderName(): string {
  return getProductConfiguration().cliSocketFolder ?? getDataFolderName()
}
```

这让 distro 能把 CLI 表面（`~/.catdesk/`）与用户数据（`~/.catpaw/`）分开，而 OSS 单产品下两者自然合一。日志目录 `getLogsDir()` 也挂在 CLI 目录下，与 CLI 表面同源。

`parseSkillDataPath()` / `buildSkillPathPattern()` 这组工具则用**动态构造的正则**匹配当前账号的 scoped 路径，并明确注明"属于其他账号或旧的 unscoped 工作区路径不匹配；调用方不得静默跨越账号边界"——这是安全边界的显式声明。

#### `logFileService` — 分文件日志与初始化顺序不变量

```
~/<cliFolderName>/logs/
├── main.log          10MB 轮转，electron-log hook 主进程 console.*
├── renderer.log      10MB 轮转，spyRendererConsole 收 warn/error
├── agent.log          5MB 轮转，轻量 WriteStream，Agent 流生命周期
└── conversations/     按需创建，启动时清理（保留 50 个 / 7 天）
    └── {convId}.log
```

**为什么 agent.log 不用 electron-log？**  因为 Agent 事件是高频流式的，走 electron-log 的格式化管线会有明显开销，且会把 main.log 冲爆。用裸 `fs.WriteStream` 是零开销的选择。

文件头部有一条**关键不变量**：

```
Console hook ordering (critical invariant):
  1. log.initialize() hooks console.* → writes to main.log
  2. logReportService.initialize() wraps console.error/warn → remote reporting
  因为 (2) 在 (1) 之后，logReportService 的 "originalConsoleError" 是 electron-log
  包装后的版本，链路为：
    console.error(msg) → logReportService wrapper → electron-log hook → main.log + 真实 console
  DO NOT change this initialization order.
```

同时为了不打破分层（L0 不得依赖 L1 telemetry），采用了**反向注入**：

```ts
let _uncaughtErrorReporter: (() => void) | null = null
export function setUncaughtErrorReporter(reporter: () => void): void {
  _uncaughtErrorReporter = reporter
}
// main.ts 在 telemetry 就绪后调用 setUncaughtErrorReporter(cacheCrashCount)
```

#### `localFileProtocol` — `catpaw-local://` 自定义协议

解决的是一个真实痛点：Agent 回复里带的是绝对路径（如 `/Users/x/.agent-browser/tmp/screenshots/a.png`），渲染进程无法直接加载——dev 模式下 Vite 会把它解析到 `http://localhost:5173/`，生产环境 `file://` origin 又对不上。

```ts
protocol.registerSchemesAsPrivileged([{
  scheme: 'catpaw-local',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}])
```

`stream: true` 是为了支持 **Range 请求**，让本地音视频可以拖动进度条播放。协议内置 MIME 映射表覆盖图片/PDF/视频/音频。注意注册必须在 `app.ready` **之前**。

### 5.2 L3 Feature：可裁剪特性目录

`electron/services/feature/` 下 14 个独立子域，共约 270 个文件：

|目录|规模|核心职责|关键设计|
| ----| --------| --------------------------------------| -----------------------------------------------------------|
|`plugin/`|~40 文件|插件容器：发现/安装/加载/市场/生命周期|zod schema 校验、`asyncMutationQueue` 串行化写操作、`local/cloud` 双 bridge|
|`market/skills/`|~35 文件|对内 Skill 市场|安装锁（`skillLock`）、S3 下载、更新轮询、CatX 全量同步上报|
|`market/skills-external/`|~25 文件|对外 Skill 市场|企业版 API、分发轮询、bootstrap 策略槽|
|`market/mcp/`|~6 文件|MCP Server 市场|local/cloud 双 bridge|
|`system/`|~40 文件|系统能力总集|剪贴板/全局快捷键/托盘/更新器/内存指标/安全屋/键盘监听/截屏|
|`automation/`|~22 文件|定时与事件自动化|RRule 调度、动态唤醒定时器、文件监听防篡改|
|`deepLink/`|~14 文件|`catdesk://` 协议路由|handler 注册表按 hostname 分发|
|`agent/`|~9 文件|Agent 配置与 SubAgent 桥|模型类型、错误码配置|
|`voice/`|~3 文件|流式 ASR|—|
|`media/`|~5 文件|媒体处理 / ASR 转写客户端|—|
|`office/`|~6 文件|大象 IM / 邮件|内网集成|
|`wenshu/`|~7 文件|Chrome 扩展宿主|Chrome API shim + 隐藏窗口 SW|
|`pet/`|~5 文件|桌宠状态机|节流广播快照|
|`project/` `commands/` `ask/` `trafficSafeGuard/`|~15 文件|项目桥、命令桥、Ask 注册表、流量保护|—|

---

## 六、Bridge 层：渲染进程 ↔ 主进程通信契约

### 6.1 三段式通信链

```
渲染层业务代码
    │  import { bridge } from '@/bridge'
    ▼
src/bridge/domains/<domain>.ts        ← 领域化薄封装（本层，51 个 domain）
    │  getElectronAPI()?.method?.() ?? 安全默认值
    ▼
window.electronAPI                    ← preload 经 contextBridge 注入
    │  ipcRenderer.invoke / on
    ▼
electron/ipc/handlers/*               ← 主进程 IPC handler
    │
    ▼
electron/services/**                  ← 业务服务
```

### 6.2 类型的单一事实源

这是 `vite-env.d.ts` 里最重要的一段设计：

```ts
import type { ElectronAPI } from '../electron/preload'
declare global {
  interface Window { electronAPI: ElectronAPI }
}
```

`ElectronAPI` 直接 `typeof` 自 preload 聚合后的对象，**渲染层看到的契约与 preload 运行时暴露的完全一致，零手写重复、零漂移**。跨进程的 `import` 是 type-only 的，`isolatedModules: true` 保证编译期擦除，**运行时无任何耦合**。

新增 IPC 方法的流程因此简化为："在 `electron/preload/<domain>.ts` 加方法 → 完。"

### 6.3 领域划分：51 个 domain

```ts
export const bridge = {
  // 系统与窗口
  system, window, taskManager, clipboard, shell, keyboard, notify, watermark,
  // 身份与环境
  auth, env, runtime, runMode, horn, diagnostics,
  // 工作区数据
  projects, sessions, folders, files, storage, settings, workspace,
  // Agent
  agent, agentConfig, agentHost, memory, todos, tool, tokenUsage,
  // 云端
  cloudChannel, cloudConversation, cloudSession,
  // 扩展生态
  skills, externalSkills, plugin, mcpMarket, commands, ask, snippets,
  // 交互面板
  ui, browser, terminal, quickChat, voice, selection, crossWindow, pet,
  // 其他
  automation, updater, cli, feedback,
  ...distroBridgeSlots,   // ← distro 可注入全新顶层 domain
} as const
```

### 6.4 四条设计原则

`bridge.ts` 头部注释明确列出：

1. **领域化 API**：`bridge.<domain>.<method>()`，UI 层**绝不**直接访问 `window.electronAPI`
2. **防御式降级**：preload 缺失（单测 / mock / 加载失败）时短路为 `undefined` / `null` / `false` / NOOP disposable，**绝不抛错**
3. **薄转发**：每个领域只是一组绑定函数，**不做缓存、不存状态**
4. **单一事实源**：`getIDEContext()` 作为遗留兼容层转发到 bridge，新代码统一用 `bridge`

降级的实现全部集中在 `shared.ts`：

```ts
export const NOOP_DISPOSABLE: IDisposable = { dispose: () => {} }
export function getElectronAPI(): Window['electronAPI'] | undefined {
  if (typeof window === 'undefined') return undefined
  return window.electronAPI
}
```

调用方一律写成 `getElectronAPI()?.xxx?.() ?? <默认值>`。这样单元测试**不需要 mock 整个 electronAPI** 就能跑组件测试——直接跑在降级路径上。

值得注意的是**默认值的语义选择**：

```ts
send:   () => p ?? Promise.reject(new Error('agent.send unavailable'))  // 必须失败可见
stop:   () => …?.stopAgentQuery?.(id) ?? Promise.resolve()              // 幂等，静默成功
getStatus: () => …?? Promise.resolve({ status: 'idle' })                // 安全快照
listActiveConversations: () => … ?? Promise.resolve([])                 // 空集合
tryResendPendingInput:   () => … ?? Promise.resolve(null)               // null → 调用方回退 retry
```

 **"发送必须报错，停止可静默"**  ——降级策略是按语义逐个方法决定的，不是一刀切。

### 6.5 `useBridgeEvent`：订阅生命周期的统一封装

这是渲染层订阅 IPC 事件的**唯一入口**，解决了 6 个真实问题：

```ts
useBridgeEvent(bridge.agent.onEvent, handleEvent, {
  onSubscribed: () => bridge.agent.addActiveSession(sessionId),
  deps: [sessionId],
})
```

|设计点|解决的问题|
| ---------------| ---------------------------------------------------------------------------------------------------|
|**自动 dispose**，cleanup 包 `try/catch`|preload 侧异常导致连锁 unmount|
|**​`useLayoutEffect`​**​ ** 订阅**（而非 `useEffect`）|缩短 "commit 完成 → 开始订阅" 的事件丢失窗口|
|**handler 存 ref** 并在 `useLayoutEffect` 同步更新|回调始终是最新闭包，且不因 handler 变化重订阅|
|**​`onSubscribed`​**​ ** 回调**|订阅成功后立刻拉快照 / 触发主进程 replay 广播，彻底关掉"订阅前事件被丢弃"的窗口|
|**显式 **​**​`deps`​**|需要随 props 重订阅时语义清晰，先 dispose 旧的再建新的|
|**DEV 双重告警**|① subscribe 引用在 render 间漂移（疑似 render 内新建函数）② 拿到 `NOOP_DISPOSABLE`（通道根本没接上，事件永不触发）|

第 6 条 DEV 告警特别有价值——`NOOP_DISPOSABLE` 检测能在开发期立刻暴露"这个 IPC 通道压根没接"的静默 bug，否则只会表现为"功能不生效但没报错"。

---

## 七、渲染进程架构

### 7.1 目录职责

```
src/
├── main.tsx           启动引导（严格的 CSS 加载顺序 + 三个初始化）
├── App.tsx            根组件：主题、i18n、路由分流、全局 hook 注册
├── bridge/            ★ 唯一的 IPC 出口（51 domain）
├── platform/          ★ VSCode 式平台层：commands / keybinding / contextkey
├── contributions/     业务命令贡献（工厂函数 → IDisposable）
├── stores/            Zustand 单 store + 40+ slice 自注册
├── services/          无 UI 依赖的业务服务（preview / cloud / agent channel / telemetry）
├── hooks/             ~96 个 hook，业务逻辑主载体
├── components/        ~58 个组件目录
├── i18n/              自研轻量 i18n（zh-CN / en）+ 运行时品牌名注入
├── utils/             ~47 个纯函数工具
├── types/             渲染层类型
├── data/              静态数据（slash 命令、AI 工具、快速开始）
└── contributions/     命令注册
```

### 7.2 状态层：Zustand 单 Store + Slice 自注册

#### 自注册模式

40+ 个 slice 各自在文件末尾调用 `registerSlice`，`catDeskStore.ts` 只做装配：

```ts
export const useCatDeskStore = create<CatDeskState>((...a) => ({
  ...Object.assign({}, ...getRegisteredSlices().map((entry) => entry.create(...a))),
  isInitialized: false,
  initialize: async () => { /* 加载 UI 偏好 */ },
}))
```

注册表结构定义了**每个 slice 可声明自己的启动任务**：

```ts
export interface SliceEntry {
  name: string
  create: StateCreator<CatDeskState, [], [], Partial<CatDeskState>>
  beforeInit?: Step   // UI 渲染前的阻塞初始化
  afterInit?: Step    // UI 已显示后的后台初始化，失败不影响用户
}
```

新增/删除 slice 只需改 `slices/index.ts` 的 import 列表——**注册顺序 = import 顺序**。

#### 分阶段启动编排

这是全文最值得学习的启动性能设计：

```
Phase 1a  ── 阻塞、且必须最先 ──
  await Promise.all([ runModeBeforeInitStep, envBeforeInitStep ])
  ▲ runMode 决定数据源（local 桶 / cloud 桶）
    env    决定分片（test / prod）
    loadProjects / loadSessions 都依赖二者；并行会命中竞态
    二者彼此独立 → 并行 await，耗时取 max 而非 sum

Phase 1b  ── 阻塞、彼此独立 ──
  await Promise.all(beforeInitSteps.map(step => step(state)))
  ▲ 串行 4-6 次 IPC 约 200-800ms；并行后只受最慢一次约束

Phase 1c  ── 非阻塞补拉 ──
  void loadExpandedProjectsFirstPage()
  ▲ 修复"重启后持久化展开的项目显示『暂无对话』"
    首屏只预拉视口内前 N 个，其余是 loaded=false 占位

  ★ setState({ isInitialized: true })  ← 解锁 UI 渲染

Phase 2   ── 非阻塞后台 ──
  for (const step of afterInitSteps) void step(state)
```

`isInitialized` **刻意不在 **​**​`initialize()`​**​ ** 里设置**，注释解释了原因：

> 在那里设置会导致 ChatArea 在 sessions 可用前就渲染，使 `committedConversationId` 被初始化为 null，默认会话的历史加载不出来。

#### Quick Chat 的瘦身初始化

Quick Chat 需要极致启动速度（目标 50–100ms），因此有独立路径：

```ts
const QUICK_CHAT_DEFERRED_SLICES = new Set([
  'auth', 'darkMode', 'channel', 'modelList', 'cloudChannel',
])
```

只跑 `loadProjects` + `loadSessions` 就解锁 UI，其余 slice 的数据在 Phase 3 后台补齐，且**只补这 5 个**——`tab` / `overlay` / `terminalPanel` / `chatSearch` / `monitor` 等主窗口专属 slice 完全跳过，避免浪费内存。

同时用 `_initPromise` / `_quickChatInitPromise` 双 promise 做去重，保证主窗口后续初始化不重复劳动。

注释里还留了一条踩坑记录：`env` 原本在延迟集里，但会导致"用默认 `'prod'` 分片查询把当前会话（非 prod）漏掉后被 dangling-clear 误清"，所以被提前到 Phase 2。

### 7.3 平台层：VSCode 式的 Command / Keybinding / ContextKey

这三件套是整个渲染层交互的骨架，设计明显借鉴 VSCode。

#### CommandRegistry

全局单例，`Map<CommandId, CommandDescriptor>`。三个细节值得注意：

**① 快照缓存保证引用稳定**

```ts
getAll = (): readonly CommandDescriptor[] => {
  if (!this.snapshot) this.snapshot = Array.from(this.commands.values())
  return this.snapshot
}
```

配合 `useSyncExternalStore`，注册表未变时返回同一引用，不触发无意义 re-render。`notify()` 时置 `snapshot = null` 失效缓存。

**② **​**​`dispose`​**​ ** 的身份校验**

```ts
dispose: () => {
  const existing = this.commands.get(descriptor.id)
  if (existing === descriptor) {   // ← 只删自己注册的那个
    this.commands.delete(descriptor.id)
    this.notify()
  }
}
```

防止"后来者已覆盖同 ID，此处 dispose 把新的误删"。

**③ i18n 驱动的显式刷新**

```ts
subscribeRuntimeCoworkLocale(() => commandRegistry.refresh())
subscribeRuntimeBrandName(()  => commandRegistry.refresh())
```

命令的 `title()` 依赖 locale 与品牌名，这些外部状态变化时底层 Map 没变、订阅者不会被触发，命令面板就会停留在旧语言。`refresh()` 提供显式刷新句柄。

#### ContextKeyService

维护命名上下文键（`terminalFocus` / `editorFocus` / `chatInputFocus`…），供 `when` 表达式求值。

亮点是**声明式焦点键**：

```ts
contextKeyService.registerFocusKey({ key: 'terminalFocus', selector: '.terminal-container' })
```

内部监听 `document` 的 `focusin` / `focusout`（capture 阶段），用 `document.activeElement.closest(selector)` 判定命中。组件**不需要写任何 focus/blur 回调**，只要 DOM 上有对应 class 即可。

`set()` 里做了值相等短路，避免无谓通知。

#### KeybindingService

渲染层唯一的 keydown 派发器，功能对齐 VSCode：

- **Chord 支持**：`mod+k mod+s` 两段式，首键命中后 1000ms 超时窗口
- **权重决胜**：`KeybindingWeight.User` > `Builtin`
-  **​`-commandId`​**​ ** 移除语义**：与 VSCode 完全一致
- **平台键选择**：`mac` / `win` / `linux` / `key` 四级回退
- **​`scope: 'global'`​** ：标记为系统全局热键的规则**不参与渲染层派发**（真实触发在主进程 `globalShortcut`），仅用于设置页与命令面板展示

两个特别精细的设计：

**① Chord 首键必须 **​**​`preventDefault`​**​ ** 并返回 true**

```ts
if (this.startsAnyChord(stroke)) {
  this.chordPending = { firstStroke: stroke, timer: setTimeout(…, CHORD_TIMEOUT_MS) }
  e.preventDefault()
  return true
}
```

否则首键会被原生输入框（Lexical / textarea / contenteditable）吃掉变成字符。

**② **​**​`passive`​**​ ** 标记的继承机制**

内置规则把 `escape → chat.stopGeneration` 标为 `passive`（命中只发信号、不 `preventDefault`），把 Esc 关闭 Dialog 的原生行为留给下游。但用户在设置页改键写入的 user 规则不带 `passive` 字段，一旦覆盖同命令，语义就丢了——**所有 Radix 弹窗的 Esc 关闭会全部失效**。

```ts
const passiveCommands = new Set<string>()
for (const r of this.builtinRules) if (!r.removal && r.passive) passiveCommands.add(r.command)
// …
.map(r => r.source === 'user' && !r.passive && passiveCommands.has(r.command)
  ? { ...r, passive: true } : r)
```

**③ 整组覆盖兜底**

用户写了正向覆盖但没补 `-cmd` 时，把同命令的所有 builtin 视为已移除，防止新老键同时触发。已显式写 `-cmd|key` 的走精细路径，不参与整组覆盖。

**④ **​**​`version`​**​ ** 单调递增作为 snapshot**

```ts
private notify(): void {
  this.resolvedDirty = true
  this.version++          // ← 必须在 listener 之前
  for (const l of this.listeners) { try { l() } catch (err) { … } }
}
```

避免 listener 未注册期间 notify 被吞导致的 tearing。

#### contributions/ — 命令的业务贡献

```ts
export { registerPanelCommands,      type PanelDeps }      from './panelCommands'
export { registerNavigationCommands, type NavigationDeps } from './navigationCommands'
export { registerSessionCommands,    type SessionDeps }    from './sessionCommands'
export { registerChatCommands,       type ChatDeps }       from './chatCommands'
export { registerWorkbenchCommands,  type WorkbenchDeps }  from './workbenchCommands'
export { registerEditorCommands,     type EditorDeps }     from './editorCommands'
export { registerPopoutCommands,     type PopoutDeps }     from './popoutCommands'
export { registerQuickChatCommands,  type QuickChatDeps }  from './quickChatCommands'
export { registerVoiceCommands }                            from './voiceCommands'
```

统一模式：`register*Commands(deps) → IDisposable`，调用方在 `useEffect` 中传入回调，卸载时统一 dispose。依赖显式注入而非从 store 直接取，让命令逻辑可独立测试。

### 7.4 服务层与 Hook 层

**​`services/`​**  是无 React 依赖的业务服务，可被 hook、组件、甚至其他 service 复用：

- `agent/` — `IAgentChannel` 抽象 + local/cloud 双实现 + `getAgentChannel(runMode)` 工厂
- `previewService.ts` — 文件预览编排（1300+ 行）：Monaco / 图片 / 音视频 / 在线渲染四条路径 + 全局 LRU tab 淘汰
- `cloud/` — SSE 事件分发、列表加载、会话状态
- `createScopedStore.ts` — 按账号分片的渲染层配置存储工厂
- `clientObservabilityService.ts` — console 拦截、全局错误兜底、Long Task / Event Timing / 内存采集
- `notificationService` / `announcementService` / `fileNavigationService` / `tokenUsageService`

`previewService` 里的**全局 LRU 淘汰**值得一提：

```ts
function enforceGlobalEditorTabLimit(newTabId: string): void {
  // 淘汰前快照 id → filePath，供淘汰后停对应 watcher（action 只回 id）
  const evictedIds = state.evictLruEditorTabsIfNeeded(newTabId)
  for (const id of evictedIds) {
    const filePath = idToPath.get(id)
    if (filePath) bridge.files.unwatchForPreview(filePath)   // ← 关键：同时停 watcher
  }
}
```

注释点明："per-session 软上限只管单会话，挡不住多会话累积，这里是根治多产物预览撑爆 JS 堆的关键"。淘汰 tab 时必须同时停掉 file watcher，否则 watcher 泄漏、且文件变更还会回推到已不存在的 tab。

**​`createScopedStore`​** 抽象了 4 处重复样板（用户快捷键 / 命令别名 / 快捷面板使用频率 / 已读公告）：

```ts
export interface ScopedStore<T> {
  hydrate(): Promise<void>   // 从主进程 scoped store 读入
  load(): T                  // 同步读缓存
  save(value: T): void       // 写缓存 + fire-and-forget 落盘
  subscribe(cb): () => void  // 订阅变化
}
```

关键在于它**内部自行订阅 **​**​`bridge.storage.onStorageScopeChanged`​**，账号切换时自动重 hydrate 并通知订阅者。消费方只需 `subscribe()`，无需感知 scope 切换。数据落主进程而非 `localStorage`，故切账号时随 storage scope 一起隔离，**绝不残留上一个账号的数据**。

**​`hooks/`​**​ **（~96 个）**  是业务逻辑的主要载体，几类：

|类型|代表|说明|
| --------| ----| -------------------------------|
|Facade|`useConversation`|组合 6 个子 hook，对外 API 不变|
|事件桥|`useAgentEventHandler` `useCloudChannelEventBridge`|IPC 事件 → store|
|Toast 桥|`useNetworkErrorToast` `useAgentStderrToast` `useEnvRestartToast`|错误 → UI 提示|
|跨窗口|`useCrossWindowSync` `useTodosSyncListener` `useSandboxSyncListener`|多窗口一致性|
|数据|`usePluginsData` `useSkillsData` `useExternalSkillsData`|列表加载与派生|
|交互|`useKeybindingDispatcher` `useGlobalShortcuts` `useSlashMenu`|输入处理|
|搜索|`unifiedSearch/` `quickSearch/` `search/`|三套搜索场景|

`useConversation` 的 Facade 分工在注释里写得很清楚：

```
- useSSEConfig             SSE 连接配置 (token / env)
- useSessionState          会话状态计算、sessionId 切换重置
- useAgentEventHandler     Agent IPC 事件处理与监听
- useConversationActions   send / stop / resume / retry / retryLast
- useMessageProcessors     TODO / Artifact 消息提取
- useConversationPersistence  history-fetch 完成后反向同步到 SessionMessageStore
```

并且明确了状态管理契约：

```
session.status 是运行状态的唯一来源，通过 updateSession 更新 store，同时用于：
  - ChatArea 的 isRunning / canStop 按钮状态
  - 侧边栏运行状态图标
  - 后台会话完成通知
  - 持久化到 storage
isRunning = session.status === 'running'
canStop   = isRunning && !!conversationId
```

---

## 八、Local / Cloud 双运行时（Dual-Runtime）架构

这是整个系统最核心的架构创新之一。目标：**同一份 UI 代码，既能驱动本机 Agent 进程，也能驱动云端远程 Desk**。

### 8.1 统一模式

在**主进程**和**渲染进程**两侧，都采用同一个模式：

```
         IXxxBridge（接口契约，定义在 @shared/types）
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
  localXxxBridge          cloudXxxBridge
  （本地文件系统 /         （Pike RPC 打到远端 Desk /
    子进程 / SQLite）        云端沙箱容器）
        └───────────┬───────────┘
                    ▼
          getXxxBridge()  按 runMode 分发
```

主进程侧已落地的双 bridge：

|Bridge|契约位置|local 实现|cloud 实现|
| ------| --------| ----------| ----------|
|`IPluginBridge`|`@shared/types/plugin`|`localPluginBridge`|`cloudPluginBridge`|
|`ISkillBridge`|`skills/bridge/types`|`localSkillBridge`|`cloudSkillBridge`|
|`IExternalSkillBridge`|`skills-external/bridge/types`|`localExternalSkillBridge`|`cloudExternalSkillBridge`|
|`IMcpBridge`|`mcp/bridge/types`|`localMcpBridge`|`cloudMcpBridge`|
|`IAutomationBridge`|`@shared/types/automation`|`AutomationService`|`CloudAutomationBridge`|
|`IProjectBridge`|`project/projectBridge/types`|`localProjectBridge`|`cloudProjectBridge`|
|`ICommandBridge`|`commands/commandBridge/types`|`localCommandBridge`|`cloudCommandBridge`|
|`ISubagentBridge`|`agent/subagentBridge/types`|`localSubagentBridge`|`cloudSubagentBridge`|

统一的分发实现：

```ts
function resolveMode(): RunMode {
  try { return getStorageService().getRunMode() }
  catch { return RUN_MODE.LOCAL }   // ← 启动早期 / 单测时 storage 未就绪，兜底 LOCAL
}
export function getPluginBridge(): IPluginBridge {
  return isCloudRunMode(resolveMode()) ? cloudPluginBridge : localPluginBridge
}
```

### 8.2 边界的精确定义

`pluginBridge/types.ts` 明确了 bridge 的适用边界：

> bridge 语义：**仅在 **​**​`pluginHandlers.ts:plugin:*`​**​ ** IPC 入口使用**，local/cloud 按 runMode 分发。主进程内部同步消费 plugin 的代码（resource discovery / clientConfig provider / startup reconciliation）**不经过 bridge**，直接走 `feature/plugin` 内各服务的具名导出。

这条边界很关键：**bridge 是"UI 请求的分发器"，不是"内部服务的门面"** 。主进程内部逻辑（比如给 Agent SDK 注入 `enabledPlugins`）永远只关心本地状态，走 bridge 反而会引入不必要的云端往返。

同一文件还记录了一条历史教训：

> 直接复用 `@shared/types/plugin` 里的 `IPluginBridge`，避免"electron 侧接口"和"shared 侧接口"两处漂移（历史上曾少一个 `createLocalPlugin`，导致 local/cloud 实现类型不对齐）。

### 8.3 渲染侧：`IAgentChannel`

渲染层只持有一个 `IAgentChannel` 实例，调用 4 个动作，不关心底层是 `catpaw-cli + SDK` 还是 `Pike + SSE`：

```ts
export interface IAgentChannel {
  appendUserMessageBeforeSend(input: UserMessagePlaceholderInput): void
  send(message: string, options?: IAgentQueryOptions): Promise<AgentSendOutcome>
  stop(conversationId: string): Promise<unknown>
  resume(conversationId: string): Promise<AgentRecoveryResult>
  retry(conversationId: string, options?): Promise<AgentRecoveryResult>
  tryResendPendingInput(conversationId: string): Promise<AgentSendOutcome | null>
}
```

工厂函数刻意**不订阅 store**：

> 调用方通常已经从 store 选出了 runMode，避免重复订阅带来不必要的渲染。channel 实例本身是无状态单例（实现内部只是 IPC 包装），可在多个 hook / window 间共享。

#### 两个实现的语义差异（被完全封装）

**差异 1：占位消息**

```ts
// localAgentChannel: 写一条 `user-${ts}` 占位，去重随后的 SSE user_message echo
// cloudAgentChannel: noop —— 远端 sendMessage 返回真实 messageId 会立刻被 SSE 转回上屏，
//                    占位 + 真实 id 会变双行
appendUserMessageBeforeSend(_input) { /* noop */ }
```

**差异 2：retry 语义**

```ts
// Cloud retry = resume —— 远端 agent-host 按 conversation 上下文重试
async retry(conversationId) { return cloudAgentChannel.resume(conversationId) }
```

#### `tryResendPendingInput`：一个精妙的恢复路径

场景：ssoid 过期导致 `POST /round` 失败，服务端**根本没建立 round**。此时 `resume(retry)` 无可续 round，只会拿到 `server-rejected-resume`，UI 会卡死。

解法是缓存上一次 send 的原始输入：

```ts
const lastSentInputs = new Map<string, CachedSendInput>()
```

缓存生命周期的注释解释了一个关键决策：

> **不在 terminal 状态清缓存**：ssoid 过期收敛流恰发生在用户点 banner 之前一刻，提前清会让 `tryResendPendingInput` 拿不到输入 → `resume(retry)` 必失败 → UI 卡死。生命周期由"下一次 send 自然覆盖"决定，边界是 conversationId 数，无泄漏风险。

还有一个边界处理：

```ts
async tryResendPendingInput(conversationId) {
  const cached = lastSentInputs.get(conversationId)
  if (!cached) return null
  // 首次 send 时缓存的 options.conversationId 为空（新会话还没 id），
  // 直接重发会漏带 conversationId → 远端再建一个新会话。这里用真实 id 注回。
  return cloudAgentChannel.send(cached.message, { ...cached.options, conversationId })
}
```

### 8.4 Cloud Channel：本机作为远端 Desk 的客户端

`cloudChannelBridge` 暴露 5 类能力：状态查询、重连/断开、CIBA 授权、通用 RPC、事件订阅。

**通用 RPC + 类型化 facade** 是很好的分层：

```ts
rpc: <T>(domain: string, method: string, params?: unknown): Promise<T> => …

conversation: {
  sendMessage: (p: SendMessageParams) => rpc<SendMessageResult|null>('conversation','sendMessage', p),
  cancel:      (p: CancelParams)      => rpc<CancelResult|null>('conversation','cancel', p),
  resume, setModelMode, share, setPin, rename, delete, archive, unarchive, getSubSessions,
}
```

设计目标（注释原文）：

> - 调用方代码与 mobile / SDK `ConversationApi` 一一对齐，可直接对照协议文档
> - 入参/出参类型直接复用 `@catx/desk-channel-sdk` 导出的接口，避免在 IPC 层重新声明一份"半成品类型"，未来 SDK 升级新增字段无须同步修改
> - 底层仍统一走 `cloudChannel:rpc` 这**一个** IPC channel；新增 SDK 域/方法只需要这里多加一行类型化包装，**不需要改 IPC 协议表**

错误语义也做了区分：**业务错误按 throw 抛出**，只有 **lifecycle 类错误（连接 detach / closed）才降级为 null**。

`CloudChannelStatus` 里有一处容易踩的坑被显式标注：

```ts
/**
 * 远端 Desk 是否在线（来自 Gateway 推送的 gateway.deskOnline / deskOffline）。
 * 本端 Pike `state === 'ready'` 不代表远端 desk 进程还活着 —— UI 做离线 banner
 * 时需同时考虑两者。
 */
remoteDeskOnline: boolean
```

**本地连接就绪 ≠ 远端服务存活**——这是所有长连接系统都会遇到的经典问题。

代码里还有对 SDK 版本滞后的**规范化临时处理**：

```ts
// ── 临时本地类型：archive / unarchive ──
// agent-host 的 protocol/conversation.ts 已声明 ArchiveParams 等，但当前锁定的
// 发布版（@catx/desk-channel-sdk@0.1.2）尚未 export 到 dist。
// SDK 下次发版同步后，把这一段删掉、改回从 SDK 直接 import 即可。
```

每处都写明"何时删除、怎么删除"——这是控制技术债的好习惯。

---

## 九、Slots 扩展点机制：OSS / Distro 的分离之道

### 9.1 核心机制

全仓 **70+ 个 **​ **​`*Slots.ts`​** 文件构成了 OSS 与 distro 的分离契约。

```
构建时：distroResolvePlugin（Vite 插件）
    │
    ├─ 若 distro 目录下存在同相对路径的同名文件 → 用 distro 版本
    └─ 否则                                    → 用 OSS 默认版本
```

命名约定见 `CODING_STANDARDS.md` 第 6.2 节。每个 slot 通常配一个 `*Slots.types.ts` 存放类型契约，让 distro 只需实现契约而不必反向依赖 OSS 实现。

### 9.2 五种 Slot 形态

#### 形态 1：常量值（最简单）

```ts
// stores/slices/darkModeSlots.ts
export const darkModeSlot: DarkModeSlot = {
  defaultEnabled: false,   // 开关默认隐藏
  forceEnabled: false,     // 仍受 Desk-DarkMode 灰度控制
}
// external 租户 shadow → { defaultEnabled: true, forceEnabled: true }
```

```ts
// components/ChatAreaV2/chatInputSlots.ts
export const CHAT_INPUT_DEPLOYMENT: ChatInputDeployment = 'internal'
export const CHAT_INPUT_FORCE_V2 = false
export const CHAT_INPUT_DISABLE_ATTACHMENT_FILTER = false
export const CHAT_INPUT_VOICE_INPUT_ENABLED = true
export const VOICE_INPUT_ALWAYS_ON = false
```

注释明确要求：**保持文件扁平，一个 slot 一个 export**，这样 OSS 与 distro 的差异 diff 是一行对比。

`CHAT_INPUT_VOICE_INPUT_ENABLED` 的注释还点出了一个 tree-shaking 考量：

> 保持这是**构建时常量**（而非运行时 store 读取），这样禁用分支能把 voice hooks 从 external bundle 里 tree-shake 掉。

#### 形态 2：函数（可动态求值）

```ts
// components/SettingsPage/settingsRegistrySlots.ts
export const MEMORY_TAB_FORCE_VISIBLE = (): boolean => false
export const MEMORY_TAB_FORCE_HIDDEN  = (): boolean => false
export const subscribeSettingsRegistryVisibility = (_l: () => void) => () => {}
export const getSettingsRegistryVisibilityVersion = (): number => 0
```

`subscribe` + `getVersion` 这对是标准的 `useSyncExternalStore` 契约——distro 能让设置项显隐**响应式**变化（如企业版身份异步解析完成后隐藏 memory tab）。

#### 形态 3：noop 函数（能力开关）

```ts
// services/telemetrySlots.ts
export function reportApiPerformanceSlot(_api: ApiPerformanceData): void { /* OSS noop */ }
export function handleMainProcessMetricSlot(_metric: MetricItem): void  { /* OSS noop */ }
export function setPageActivitySlot(_activity: PageActivity): void      { /* OSS noop */ }
```

OSS 不带任何遥测实现，distro 注入 Owl / Raptor / LX。

#### 形态 4：组件槽（UI 注入）

```ts
export const ChatModeSlotComponent: ComponentType | null = null
export const distroSettingsSections: SectionDef[] = []
```

`GlobalOverlaySlot` 在 `App.tsx` 里被无条件渲染，OSS 默认渲染 `null`：

```tsx
{/* distro 注入的全局浮层（OSS 默认 null）：如 external 登录后「积分已到账」欢迎弹窗 */}
<GlobalOverlaySlot />
```

#### 形态 5：类型合并槽（新增整个 domain）

这是最有意思的一种。`distroSlots.ts` 允许 distro **新增一个全新的顶层 bridge domain**：

```ts
// src/bridge/domains/distroSlots.ts
export const distroBridgeSlots: DistroBridgeSlots = {}

// src/bridge/domains/distroSlots.types.ts
export interface DistroBridgeSlots {}   // ← 空接口，distro 用 declare module 合并
```

distro 侧：

```ts
declare module '.../src/bridge/domains/distroSlots.types' {
  interface DistroBridgeSlots {
    officeAddin?: typeof officeAddinBridge
  }
}
```

`bridge.ts` 把它 spread 进聚合对象：

```ts
export const bridge = { system, taskManager, /* … */, ...distroBridgeSlots } as const
```

它与同目录的 `authSlots.ts` / `envSlots.ts` / `skillsSlots.ts` 的区别在注释里写明了：**那些是给已有 domain 注入方法；本文件用于新增整个顶层 domain**。并且需要与 preload 侧的 `extensions/distroDomains.ts` 配合——preload 暴露 IPC 方法，bridge slot 把它包装为 domain 对象供 UI 调用。

### 9.3 Slot 分布图

|层级|数量|代表|
| --------------| ----| -------|
|主进程 base|4|`browserPartitionSlots` `dataPathScopeSlots`|
|主进程 feature|18|`safeRoomSlots` `enterpriseMarketplaceSlots` `petAuditSlots` `updateRequestSlots` `winStagedUpdateSlots` `skillsBridgeProviderSlots` `externalSkillBootstrapPolicySlots`|
|渲染 bridge|8|`authSlots` `envSlots` `skillsSlots` `pluginSlots` `distroSlots`|
|渲染 store|12|`darkModeSlots` `envSlots` `previewPanelSlots` `projectAvailabilitySlots` `sessionArchiveSlots` `sessionUnarchiveSlots` `sessionPermanentDeleteSlots`|
|渲染 service|5|`telemetrySlots` `telemetryInitSlots` `documentPreviewSlots`|
|渲染 hook|4|`enterpriseEpGuardSlots` `expertAccessGuardSlots` `slashMenuSkillsSlots`|
|渲染组件|25+|`chatInputSlots` `mainHeaderSlots` `welcomeLayoutSlots` `settingsRegistrySlots` `sessionDeleteSlots` `mobileQrSlots` `bottomBarPluginsSlots` `contextBarPluginsSlots`|

### 9.4 Slot 与"物理裁剪"的配合

`chatInputSlots.ts` 里揭示了一个更进阶的用法——slot 是**代码物理裁剪的开关**：

> external 租户 → `false`（`voice-input` catalog feature 不在 external manifest 里，主进程 ASR 服务已被 L1-stub，渲染层不能再挂载已死的 mic 入口）。这个 gate 是渲染侧的对应物，让 voice UI 文件可以经 `voice-input.stubPaths.renderer` 被物理剪掉。

也就是说 distro 有一套 **feature catalog + stubPaths** 机制：声明某个 feature 不启用时，主进程服务被 stub、渲染层文件被物理移除，而 slot 常量保证残留的引用点不会去 import 已删除的模块。

`safeRoomSlots.ts` 是另一个例子：

```ts
export const safeRoomSlot: SafeRoomSlot = { enabled: true }
```

`system/providers.ts` 里据此做三处短路：

```ts
if (!safeRoomSlot.enabled) return { IS_SAFE_ROOM_AGENT: 'false' }   // 不发 token 请求
// …
if (safeRoomSlot.enabled) registerProvider('browserPlugin', createSafeRoomTokenBrowserPlugin())
```

注释解释了为什么必须短路而不能只是"返回空"：**否则会 POST **​ **​`/api/oauth/safe-room-token`​**——对没有安全屋后端的租户来说这是一个必然 404 的无效请求。

---

## 十、Provider Registry：主进程内的依赖倒置

### 10.1 要解决的问题

分层铁律规定 **L2 core 不能 import L3 feature**。但现实中 core 确实需要 feature 的能力：

- `agentClientFactory`（core）需要知道**哪些 plugin 启用了**（feature/plugin）
- 每次 agent query 需要注入 **Safe Room JWT 环境变量**（feature/system）
- agent-host RPC 的 `subagent.*` / `skills.*` / `workspace.*` 需要**业务实现**（feature/agent、feature/market、feature/project）

如果 core 直接 import feature，一来违反分层，二来 feature 被裁剪后 core 就编译不过——**G1 可裁剪目标直接破产**。

### 10.2 解法：注册表 + 依赖倒置

```
                    core/providerRegistry
                 （只定义接口，不知道实现）
                            ▲
       ┌────────────────────┼────────────────────┐
       │ registerProvider   │                    │ getSingletonProvider
       │                    │                    │
  feature/plugin      feature/system         core/agent/*
  feature/agent       feature/market         agent-host handlers
  feature/project     feature/commands
  feature/automation
```

**启动时**：`main.ts` 依次调用各 feature 的 `register*Providers()`。
**运行时**：core 通过 `getSingletonProvider('xxx')` 取实现；**取不到就走默认行为**（feature 被裁剪的场景）。

### 10.3 已注册的 Provider 清单

|Provider Key|注册方|消费方|作用|
| ------------| ------------------------------| -----------------------------| -----------------------------|
|`pluginBridge`|feature/plugin|pluginHandlers|UI 的 plugin CRUD|
|`clientConfig`|feature/plugin, feature/market|core/agent/agentClientFactory|向 Agent SDK config 贡献片段|
|`shellEnv`|feature/system|core/agent（每次 query）|注入 Safe Room JWT 等环境变量|
|`workspaceSettings`|feature/system|agent-host workspace RPC|设置变更的跨进程副作用|
|`systemUpgrade`|feature/system|agent-host / CLI|`checkUpgrade` / `applyUpdate`|
|`browserPlugin`|feature/system|core/browser|向特定域名页面注入脚本|
|`subagentBridge`|feature/agent|agent-host subagent RPC|SubAgent 列表/模型/工具/迁移|
|`skillsBridge`|feature/market|agent-host skills RPC|Skill 安装/卸载/查询/更新|
|`mcpBridge`|feature/market|agent-host mcp RPC|MCP Server 管理|
|`automationBridge`|feature/automation|agent-host automation RPC|定时任务 CRUD|
|`projectBridge`|feature/project|agent-host workspace RPC|项目 CRUD|
|`commandBridge`|feature/commands|agent-host commands RPC|自定义命令|

### 10.4 `clientConfig`：聚合型 Provider + 脏标记

这是设计最精细的一个。它允许**多个 feature 各自贡献配置片段**，由 core 用 `aggregateClientConfig` 合并：

```ts
export const clientConfigProvider: ClientConfigProvider = {
  name: 'plugin',
  async contribute() {
    const { enabledPlugins } = await readPluginSettings()
    if (Object.keys(enabledPlugins).length === 0) return {}
    return { enabledPlugins }
  },
  isDirty() {
    return consumePluginConfigDirty()   // ← install/uninstall/toggle/update 时置脏
  },
}
```

注释解释了为什么必须这么做：

> core **不能**直接 import feature/plugin（分层规则），所以 host（`agentClientFactory`）不再自己读 plugin 设置。改由这个 provider 提供片段，core 通过 `aggregateClientConfig` 合并。
>
> `enabledPlugins` 由 spawn 出来的 CLI 消费；CLI 经 SDK 启动时（inline `CATPAW_CONFIG_CONTENT` 路径）**从不读 settings.json**，所以必须由 host 注入。

`isDirty()` 的存在是为了**缓存失效**：Agent client 会被缓存复用，plugin 装卸后必须让下一次对话重建 client 拿到最新的启用集。

类型安全通过**模块增强**保证：

```
`enabledPlugins` 经 electron/types/catpaw-config-augment.d.ts 的 module augmentation
加进 SDK 的 CatpawConfigInput 表面，所以这个返回是类型安全的。
```

### 10.5 `shellEnv`：带上下文的 Provider

```ts
const safeRoomShellEnvProvider: ShellEnvProvider = {
  name: 'safeRoom',
  async contribute({ sessionId, enableSafeHouse }) {
    if (!sessionId) return null
    if (!safeRoomSlot.enabled) return { IS_SAFE_ROOM_AGENT: 'false' }
    return buildSafeRoomShellEnv(sessionId, enableSafeHouse)
  },
}
```

注释说明了合并顺序：

> `buildSafeRoomShellEnv` 已返回包含 `IS_SAFE_ROOM_AGENT` + `DAXIANG_SAFE_ROOM_TOKEN` 的完整 env 对象。core 提供一个默认的 `IS_SAFE_ROOM_AGENT` 基底；我们的返回值经 `aggregateShellEnv` 里的 `Object.assign` 顺序覆盖它。

### 10.6 与 Lifecycle 的配合

部分服务同时实现 `IService`，接入生命周期编排：

```ts
export class AutomationService implements IService, IAutomationBridge {
  readonly id = 'automation'
  readonly startPhase = LifecycleMainPhase.AfterWindowOpen
  readonly dependencies: readonly string[] = []
  // …
}
```

`AfterWindowOpen` 阶段的服务（`automation` / `power` / `memoryMetrics` / `updater`）都是**非首屏关键路径**，延后启动可以显著改善冷启动时间。`dependencies` 字段支持声明服务间依赖，由生命周期管理器做拓扑排序。

---

## 十一、扩展生态：Plugin / Skill / MCP / Command / Subagent

### 11.1 五类扩展物的关系

```
Plugin（容器 / 分发单元）
  │
  ├── skills[]      能力包（SKILL.md + 脚本 + 资源）
  ├── mcpServers{}  MCP 工具服务器
  ├── commands[]    Slash 命令
  ├── agents[]      SubAgent 定义
  └── interface{}   UI 展示元数据（名称/描述/图标/分类/快捷提示词）
```

**Plugin 是"容器扩展"** ，把 skills、MCP servers、commands、subagents 打包分发。Skill 也可以独立于 Plugin 单独安装。

### 11.2 Plugin 子系统

#### 目录布局

```
~/<dataFolderName>/plugins/
├── installed_plugins.json        用户安装的插件注册表（v2 schema，唯一事实源）
├── known_marketplaces.json       已知市场表（扁平对象，key = 市场名）
├── cache/{market}/{name}/{version}/     按 市场/名称/版本 三级隔离
└── marketplaces/{marketName}/
    ├── .catpaw-plugin/marketplace.json  市场清单
    └── .download/                        暂存下载/解压区（dot 前缀，扫描时忽略）
```

**三级版本隔离**（`cache/{market}/{name}/{version}/`）的价值：同一插件的多个版本可共存，回滚只需切换 registry 指向，无需重新下载。

#### 市场根路径的规则约束

`pluginPaths.ts` 里有一条重要的架构约束：

```ts
/**
 * 这是唯一允许出现 `marketplaces/{name}` 路径规则的地方：它定义了 seeding/recovery
 * 系统市场时写入 known_marketplaces.json 的**默认** installLocation。
 * 一旦 seeded，所有消费方必须从注册表读市场根，绝不能从名字重新推算。
 */
export function getDefaultMarketDir(marketName: string): string {
  return path.join(getMarketplacesDir(), marketName)
}
```

这条约束保证了市场可以被安装到任意位置（比如企业内网的共享目录），而不被硬编码路径绑死。

#### Schema 校验：zod 作为单一事实源

```ts
export type PluginManifest = z.infer<ReturnType<typeof PluginManifestSchema>>
export type CommandMetadata = z.infer<ReturnType<typeof CommandMetadataSchema>>
export type MarketplaceSource = z.infer<ReturnType<typeof MarketplaceSourceSchema>>
```

**类型从 schema 推导**，而不是手写类型再单独写校验——彻底消除两者漂移的可能。注意 Schema 是 `ReturnType<typeof XxxSchema>`，说明它们是**工厂函数**（大概率为了注入 i18n 上下文或延迟求值）。

#### 类型级的不变量表达

```ts
/**
 * 一个 PluginMarketplaceEntry，其 source 已被校验为本地相对路径（以 './' 开头）。
 * 这是 parseMarketplaceManifest 过滤掉无法在磁盘上解析的非本地源（npm/git/github）
 * 之后返回的条目类型。
 */
export type LocalPluginEntry = Omit<PluginMarketplaceEntry, 'source'> & { source: string }

export type LocalMarketplaceManifest = Omit<PluginMarketplace, 'plugins'> & {
  plugins: LocalPluginEntry[]
}
```

用类型系统编码"已校验"这个运行时事实，让下游代码不必重复检查。

#### 发现流程

```
scanInstalledPlugins()
  ├─ 1. 读 installed_plugins.json（用户安装，唯一事实源）
  │     └─ 逐条 fs.access(installPath) 校验，路径失效则跳过并 warn
  ├─ 2. 扫 bundled plugins（<Resources>/plugins/，随应用分发）
  │     ├─ 优先 {dir}/.catpaw-plugin/plugin.json  （规范路径）
  │     └─ 回退 {dir}/plugin.json                 （legacy 路径）
  └─ 3. 合并 → IPluginScanEntry[]

loadPlugin(dir, source)
  └─ createLoadedPlugin() → zod 校验 manifest + 逐一解析磁盘上的
                            commands / agents / skills / mcpServers / interface
```

启用状态**不在 registry 里**，而是读 `settings.json` 的 `enabledPlugins`——安装态与启用态解耦。

#### 并发控制

`asyncMutationQueue.ts` 把安装/卸载/更新这类写操作串行化，避免并发写坏 `installed_plugins.json`。对应测试 `marketplacePluginService.concurrent.test.ts`。

#### 完整服务清单（~40 文件）

|服务|职责|
| ------| ----------------------------------------|
|`pluginDiscovery`|扫描与发现|
|`pluginLoader`|manifest 解析与组件解析|
|`pluginCrudService`|增删改|
|`pluginInstallRegistry`|`installed_plugins.json` 读写|
|`pluginSettingsService`|`enabledPlugins` 读写 + 脏标记|
|`pluginStartupService`|启动时对账（reconcile）|
|`pluginResourceDiscoveryService`|向 Agent 暴露 skills/commands/agents/mcp|
|`pluginLifecycleReporter`|生命周期埋点|
|`pluginUpdatePolling`|后台更新轮询|
|`marketplacePluginService` / `marketplaceRegistryService`|市场逻辑|
|`catxMarketApiService` / `catxMarketService`|CatX 官方市场|
|`remoteMarketItem` / `remoteMarketUpdateService` / `remotePluginStagingService`|远程市场与暂存|
|`enterpriseMarketplaceSlots`|企业市场扩展点|

### 11.3 Skill 子系统

Skill 分为**对内**（`market/skills/`）和**对外**（`market/skills-external/`）两套，各有独立的 API service、bridge、安装/更新/轮询链路。

#### 目录布局

```
~/<scopedDataFolderName>/
├── skills/
│   ├── skills-market/            对内市场安装的
│   └── skills-market-external/   对外市场安装的
├── skills-disabled/              legacy 禁用目录（历史方案遗留）
├── .skills-tmp/                  更新暂存区
└── .disabled-skills.json         禁用元数据

<workspace>/<scopedDataFolderName>/skills/   工作区级 skill（同结构）
```

#### 禁用机制的演进：从"物理移动"到"热补丁"

早期方案是把禁用的 skill 目录物理移动到 `skills-disabled/`。现方案改为**原地保留 + 运行时排除**：

```ts
/**
 * New approach: skills stay in place (skills/ directory), disabled state is
 * recorded in DisabledSkillService. No file movement needed.
 *
 * After toggling, hot-patches all live clients with per-project excludeSkillPaths
 * via updateExcludeSkillPaths() — takes effect immediately without restarting CLI processes.
 */
```

热补丁走双通道，覆盖新旧两条对话链路：

```ts
function hotUpdateExcludeSkillPaths(): void {
  // 通道 1：legacy 路径 → agentService.applyHotPatchPerClient
  hotPatchExcludeSkillPaths().catch(err => console.warn(…))

  // 通道 2：新路径 → UiSdkConversationService 自行热补丁其 client
  coreEvents.emit('client:config:change', {
    source: 'skills',
    patch: { excludeSkillPaths: getDisabledSkillService().getAll() },
  })
}
```

**核心收益**：切换 skill 启用态**无需重启 CLI 子进程**，正在进行的对话不中断。且 `excludeSkillPaths` 是 **per-project** 的——每个 client 只收到与其 `workingDir` 相关的禁用路径。

#### 版本锁定（Lock）

```ts
export function isSkillLocked(installPath: string): boolean {
  const lockedPaths: string[] = getSettingsStorageService().get('lockedSkillPaths') ?? []
  return lockedPaths.includes(normalizePath(installPath))
}
```

被锁定的 skill 在**自动更新与批量更新检查中被跳过**。文件头声明了这些是"纯原子操作"，调用方负责通知渲染层（`broadcastToAll('skills:patchState', …)`）与业务副作用（Toast、平台上报）——**关注点分离**做得很干净。

#### 安装图标的 Fallback 策略

`skillsBridgeProviderSlots.ts` 里有一段与移动端对齐的图标传输协议：

```ts
/** Polynomial Rolling Hash — 从 skillId 稳定映射到 0~3 的 fallback 图标索引。
 *  必须与渲染侧 SkillFallbackIcon.tsx 的 hashSeed 保持一致。 */
function hashSeed(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0
  return Math.abs(h)
}
```

传输策略三选一：HTTP(S) URL 透传 → data URI 透传 → 无图标时传数字字符串 `"0"~"3"`，由客户端按索引渲染内置 fallback。这样**无图标的 skill 不需要传输任何图片数据**，且同一 skill 在 PC 与移动端显示同一个 fallback 图标。

#### CatX 全量同步与上报

`skills/catx/` 下有一整套上报链路：

|文件|职责|
| ----| -----------------------------|
|`catxFullSync`|全量同步本地 skill 状态到云端|
|`catxSkillReport` / `catxWorkspaceReport`|skill 级 / 工作区级上报|
|`catxS3Upload`|产物上传 S3|
|`catxCloudReport` / `catxReportBase`|上报基础设施|
|`catxSkillService`|云端 skill 变更通知的接收处理|

### 11.4 MCP / Command / Subagent

|扩展物|存储位置|分发方式|Bridge|
| ------| --------------| ----------------------| ------|
|**MCP Server**|`~/<data>/mcp/` + plugin 内联|市场 / plugin 打包|`IMcpBridge`|
|**Slash Command**|`~/<data>/commands/` + plugin 内|用户自建 / plugin 打包|`ICommandBridge`|
|**Subagent**|`~/<data>/agents/`、`<ws>/<data>/agents/`|用户自建 / plugin 打包|`ISubagentBridge`|
|**Snippet**|`~/<data>/snippets/`|用户自建（Raycast 式）|—|

`ISubagentBridge` 的接口体现了它的能力面：

```ts
list(workspacePath)      // 列出可用 subagent
availableModels()        // 可选模型
availableTools()         // 可选工具
update(items)            // 批量更新 → { success, affected }
migrate(source, scope)   // 从其他来源迁移 → { count, success }
```

`feature/agent/providers.ts` 里对每个方法都做了 **错误吞掉 + 结构化返回** 的包装：

```ts
async update(items) {
  try {
    await localSubagentBridge.update(items)
    // localSubagentBridge.update 返回 unknown，agent-sdk 那侧不一定吐 affected count，
    // 这里以传入数量近似（保持 RPC 协议非 0 即可触发刷新）
    return { success: true, affected: items.length }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.warn('[agent.providers] subagentBridge.update failed:', { error })
    return { success: false, affected: 0, error }
  }
}
```

**RPC 边界永不抛异常**，一律转成结构化的 `{ success, error }`——这是跨进程 RPC 的正确做法（异常无法可靠序列化）。

---

## 十二、核心业务子系统详解

### 12.1 Automation：定时与事件自动化

`AutomationService`（~2000 行）是 feature 层最复杂的服务，同时实现 `IService` 与 `IAutomationBridge`。

#### 调度策略：动态唤醒 + 兜底轮询

```ts
private schedulerInterval: NodeJS.Timeout | null = null   // 低频兜底轮询（安全网）
private wakeupTimer: NodeJS.Timeout | null = null         // 动态唤醒（主精度）
private wakeupDebounceTimer: NodeJS.Timeout | null = null // 变更后去抖重排
```

设计演进的注释写得很直白：

> **动态唤醒定时器**：`setTimeout` 睡到「最近一个未来 `nextRunAt`」到点后 tick 并重排。**替代原固定 30s 全量扫盘**，任务稀疏时几乎零空转。

这是典型的**从轮询到事件驱动**的优化。同时保留低频兜底轮询作为安全网，防止唤醒定时器因异常丢失。

任务 CRUD / 运行态变更后会订阅通知**去抖重排 wakeup**，不等兜底轮询——保证新建的任务能立即被调度。

#### 休眠恢复对账

```ts
private powerMonitorDisposers: Array<() => void> = []   // 休眠 / 锁屏恢复对账
```

配合常量：

```ts
MAX_WAKEUP_MS          // 单次 setTimeout 上限（防溢出）
MISSED_RUN_GRACE_MS    // 错过执行的宽限窗口
MAX_PER_TICK           // 单次 tick 最多执行几个任务（防雪崩）
FALLBACK_POLL_MS       // 兜底轮询周期
```

`MISSED_RUN_GRACE_MS` 处理的是"电脑睡了 8 小时，醒来后 3 个任务都过期了"——在宽限期内的补跑，超出的丢弃（避免醒来瞬间跑几十个任务）。`MAX_PER_TICK` 是雪崩保护。

#### RRule：iCalendar 标准调度

```ts
const RRULE_WEEKDAY_MAP: Record<Weekday, RRuleWeekday> = {
  MO: RRule.MO, TU: RRule.TU, /* … */
}
```

选 `rrule` 而非 cron 是因为它能表达"每月第二个周二"、"每个工作日"这类 cron 无法表达的规则，且是日历应用的通用标准，便于与外部系统互通。

`isRRuleFrequencyAllowed()` 说明还有**频率上限校验**——防止用户建出"每分钟跑一次 Agent"这种会烧钱的任务。

#### FolderAutomationWatcher：防 Agent 自我破坏

这是一个很有意思的防御性设计。问题场景：

> Agent 通过 Write/Edit/shell 直接落盘 `automation.json` 时不走 zod 校验，会留下 **zombie 任务**（RRule 永远跑不起来）或被 lenient read 静默吞成 null。

也就是说——**Agent 可能用通用文件工具破坏自己的调度配置**。解法是文件监听 + 严格校验 + 自动回滚：

```
fs.watch 检测到 automation.json 变化
  │
  ├─ 是自写？（markSelfWrite 在 1500ms 窗口内）→ 忽略
  │
  └─ 外部写入
      ├─ validateAutomation(strict) 通过 → onChanged() 刷新 UI
      └─ 校验失败 → 【拒绝写入】
            ├─ 有上次合法快照 → 回滚 automation.json
            ├─ 无快照        → 删除文件
            └─ 广播 automation:invalid → 前端错误卡片
```

**自写抑制**避免了无限循环：回滚 / `store.save()` 在 rename 前调 `markSelfWrite`，防止 watcher 把自己刚写回的内容当作新事件再校验一轮。窗口取 1500ms：

> `fs.watch` 一般几百毫秒内回调，1500ms 留足余量；再大会误吞同窗口内的合法外部编辑。

#### 错误精确投递：`automationToolSniffer`

```ts
/**
 * agent fs-write 工具嗅探器。挂在 agentService 上，把 `automation.json`
 * 写入对应的 conversationId 注册到 `automationConversationRegistry`，
 * watcher 拒写时反查并随广播附带，使 UI 端能把错误卡片精确投递回原会话。
 */
private agentToolSniffer: ((data: unknown) => void) | null = null
```

这解决了一个体验问题：watcher 是文件系统层的，它只知道"某个文件被写坏了"，不知道是**哪个会话的 Agent** 干的。嗅探器在 Agent 工具调用层建立 `文件路径 → conversationId` 的映射，让错误卡片能精确出现在肇事会话里，而不是全局 toast。

对应渲染侧：`useAutomationInvalidEventListener` + `AutomationInvalidCard`。注释里也记录了这次演进："automation:invalid 改走 store → ChatArea 内卡片（不再用全局 toast）"。

### 12.2 Updater：三平台差异化自动更新

```
UpdaterService（facade）
  ├─ MacUpdater      Electron 原生 autoUpdater / Squirrel.Mac（.zip）
  ├─ WindowsUpdater  JSON check + Inno Setup 安装器（.exe），overlay / mutex 双模式
  └─ LinuxUpdater    JSON check + AppImage 解压 + 原子 symlink 切换
```

三者共享 `updater/shared.ts` 里的：

- 检查请求 slot（OSS 默认 GET / external CatX POST）
- **可断点续传的指数退避下载循环**
- `IPlatformUpdater` 契约

协议约定简洁：**HTTP 200 + JSON = 有更新，HTTP 204 = 无更新**。

#### Windows 的两种更新模式

```ts
getWindowsUpdateMode(): 'overlay' | 'mutex'
```

|模式|流程|适用|
| --------| ----------------------------------------------------------------------------| ----------|
|`overlay`（默认）|直接覆盖安装，必须先停应用|简单场景|
|`mutex`|**VSCode 同款**：下载时应用还活着就 `/verysilent` 跑安装器，靠 "updating" / "ready" 一对命名互斥体协调；**无退出时安装、无外部 mover**|大规模部署|

mutex 模式需要 `getWin32MutexName()` 与 Inno Setup 脚本的 `#define AppMutex` **严格一致**：

```
app 运行时持有 <name>
Inno 安装器静默更新期间持有 <name>-updating
staging 完成后创建 <name>-ready
```

`@vscode/windows-mutex` 是可选原生依赖，加载失败时**优雅降级**——`.update-ready` 文件标记 + 轮询超时仍能驱动流程：

```ts
// 非 win32 或可选依赖缺失 / 未针对当前 Electron ABI 编译时返回 null，
// 此时安装器存活探测不可用（但 .update-ready 文件标记 + 轮询超时仍能驱动流程）。
```

#### 默认只下载不安装

```ts
// Download-only by default. Install is opt-in:
//   • UI: `/update` slash command
//   • CLI / agent: `catdesk update`
// No auto-install on `downloaded`, even in headless / container deployments.
```

这是对用户的尊重——Agent 可能正在跑长任务，绝不能因为有新版本就自动重启。

#### 失败上报

```ts
if (status === 'error') {
  bridgeReportCount(Metrics.UPDATE_FAILURE, 1, { stage: inferUpdateFailureStage(error) })
  void reportUpdateFailToGateway(app.getVersion(), info?.version ?? '', error ?? '')
}
```

`inferUpdateFailureStage()` 从错误信息推断失败阶段（check / download / verify / install），让指标可按阶段下钻。注释还点明"应用此刻还活着，无需缓存到磁盘"——与崩溃类指标的处理方式不同。

### 12.3 Browser / Terminal / Preview

#### Browser

基于 `WebContentsView`（而非已废弃的 `BrowserView`），由 `core/browser/` 管理：

|模块|职责|
| ----| ---------------------------------------------|
|`tabManager`|标签页生命周期|
|`webContentsViewManager`|原生视图挂载与 bounds 同步|
|`viewStealthSetup`|反检测（UA / 响应头改写） + session partition|
|`tools/browserAction`|暴露给 Agent 的浏览器动作工具|

**Overlay 与 React 层的 z-index 冲突**是原生视图内嵌的经典难题——`WebContentsView` 永远盖在 DOM 之上。解法是 `useOverlayAutoHide`：监听 Radix Portal（Dialog / DropdownMenu）的打开，自动隐藏 overlay。这也是为什么 `pnpm-workspace.yaml` 要把 Radix 版本锁死。

`browserPartitionSlots` 让 distro 定制 session 分区（cookie 隔离策略）。

#### Terminal

`core/terminal/ptyService` 驱动 node-pty，渲染侧是 `@xterm/xterm`。

- `terminalCache.ts` — 终端实例缓存，切换会话时不销毁重建
- `terminalPath.ts` — 工作目录解析
- `CloudTerminalPanel.tsx` — cloud 模式用 `<webview>` 嵌入容器内的 ttyd 网页终端（7681 端口）

`<webview>` 的使用被严格限制。`vite-env.d.ts` 里明确标注：

> Electron `<webview>` 标签 —— **仅供需要跨域 JS 注入的场景使用**（目前只有 `CloudTerminalPanel` 嵌入容器内 ttyd 时用）。

#### Preview：四路分发

`previewService.ts` 按扩展名分发到四条渲染路径：

|类型|渲染方式|扩展名|
| ----| ------------------------| -----------------------------------------------|
|`monaco`|Monaco Editor 只读|代码 / 文本，命中 `MONACO_LANGUAGE_MAP`|
|`image`|`catpaw-local://` 直接 `<img>`|png/jpg/gif/webp/bmp/svg/ico/avif|
|`video` / `audio`|`catpaw-local://` + Range 请求原生播放|mp4/webm/ogv/mov、mp3/wav/ogg/aac/m4a/flac/opus|
|`online`|上传后由远端渲染服务出图|Office / PDF|

Cloud 模式下 HTML 有特殊处理：

```ts
/** 浏览器可直接渲染的 HTML 扩展名 — cloud 模式优先用 previewUrl 渲染 */
const CLOUD_HTML_EXTENSIONS = new Set(['html', 'htm', 'xhtml'])
```

理由是"观感对齐网页效果"——html 会命中 `MONACO_LANGUAGE_MAP` 被当成源码看，但用户通常想看渲染结果。

本地 Office 预览还有独立的 `OfficeLocalPreview/` 组件（`docx-preview` / `pptx-preview` / `xlsx`），作为在线渲染不可用时的兜底。

### 12.4 桌宠 Overlay：节流广播的被动渲染

`PetService` 是主进程的状态机，渲染侧**纯被动只读**。

#### 插件化的状态源

```ts
register(hooks: PetPluginHooks = {}): PetPluginAPI
```

外部提供方（`agentHandlers`、`automationService`、未来的 UI SDK）通过 `register()` 拿到 API 后推送数据，PetService 不关心数据从哪来。

#### 优先级仲裁

```ts
const STATUS_PRIORITY: Record<PetSessionStatus, number> = {
  waiting: 0,   // 最高——等用户回答，必须让用户看到
  failed:  1,
  running: 2,
  review:  3,
  idle:    4,
}
```

多会话并发时，桌宠显示优先级最高的那个状态。`waiting` 排第一是产品判断：**需要用户介入的事情最紧急**。

#### 节流广播

```ts
const BROADCAST_THROTTLE_MS = 100
```

注释解释了为什么可以安全节流：

> 流式更新（每个 `model_chunk` token 都触发）被折叠为每周期至多一次 IPC 发送；**快照是全量状态，所以只有最新那一帧重要**。镜像 `sessionMessageStore` 的 `UPDATE_THROTTLE_MS` 模式。

**全量快照 + 节流**是流式 UI 的标准优化组合——增量更新必须每条都送达，全量快照只需送最新的。

还有 `suspended` 标志用于整体挂起（overlay 隐藏时不做无用广播），以及 `petAuditSlots` 供 distro 做内容审计。

### 12.5 Wenshu：Chrome 扩展宿主

这是一个"**让第三方 Chrome 扩展在 Electron 里零修改运行**"的适配层。

```
WenshuExtensionHost
  ├─ 创建隐藏 BrowserWindow 作为 Service Worker 环境
  ├─ 注入 chromeApiShim（模拟 chrome.* API）
  ├─ 加载原插件的 service-worker-loader.js（代码零修改）
  ├─ 插件建立到本地文书客户端的 WSS 连接
  ├─ wenshuContentBridge 向每个浏览器 tab 注入 content script
  └─ WenshuMessageRouter 路由消息
```

关键技巧是注册 `wenshu-sw://` **特权 scheme**：

```ts
protocol.registerSchemesAsPrivileged([{
  scheme: 'wenshu-sw',
  privileges: { standard: true, secure: true, supportFetchAPI: true,
                corsEnabled: true, allowServiceWorkers: true },
}])
```

注释解释了为什么必须这么做：

> 这让 `crypto.subtle`（Web Crypto API）在 SW 隐藏窗口里可用，插件解密来自 `cryptbox.sankuai.com` 的配置需要它。**​`file://`​**​ ** 页面不是 secure context，那里 **​**​`crypto.subtle`​**​ ** 是 undefined**。

同样，scheme 注册必须在 `app.ready` 之前。

### 12.6 DeepLink：`catdesk://` 协议路由

```
handlers: Record<hostname, DeepLinkHandler> = {
  skill, action, settings, automations, session, auth, system
}
```

支持的路由：

```
catdesk://skill                                      打开技能页
catdesk://skill/search?query=xxx                     搜索技能
catdesk://skill/install?skillId={id}                 安装确认
catdesk://action?install_skill={id}&open_url={enc}   多技能 + 多 URL 组合
catdesk://settings/{subPath}?tab={tab}               设置页深链
catdesk://automations                                自动化页
catdesk://session/open?conversationId={id}&openUrl=  打开会话（可带 URL）
catdesk://session/new?projectPath=&prompt=           新建会话并预填
<scheme>://auth/callback?ticket=&state=              登录回调
catdesk://system/toggle-dark-mode                    切换深浅色
catdesk://?client=local                              仅激活应用到前台
```

#### 冷启动 / 热运行双路径

每个 handler 都有 `consumePendingXxxDeepLink()` 导出。这是为了处理**冷启动**：应用尚未就绪时 deep link 先被缓存，窗口 ready 后由渲染层主动 consume。热运行时则直接经 IPC 事件推给渲染层。

#### 分层约束的处理

```ts
// Auth deep link 的 pending 缓冲/消费与事件通道落在 platform/auth/contracts/
// （分层约束：provider 在 L1 无法依赖 feature/）。此处仅 re-export 类型/消费函数便于聚合。
export { consumePendingAuthDeepLink } from '../../platform/auth/contracts/authDeepLinkEvents'
```

即使为了聚合导出的便利，也不破坏分层——只做 re-export，实体放在正确的层。

#### 前台激活的统一实现

```ts
function bringToForeground(): BrowserWindow | null {
  const win = _mainWindow
  if (!win || win.isDestroyed()) return null
  windowFocusSlot.bringToForeground(win)   // ← 统一实现
  return win
}
```

注释说明委托给 `windowFocusSlot` 的理由：

> 它携带了 **Windows 前台锁的 workaround + SW_HIDE 重试**，让 deep-link 激活、登录回调激活、窗口辅助函数**共享一份不会漂移的实现**。

同时主窗口引用是 `main.ts` 显式 `setDeepLinkMainWindow()` 注入的，而**不是** `BrowserWindow.getAllWindows()[0]`——后者可能返回 overlay / QuickChat 窗口。

---

## 十三、数据与存储架构

### 13.1 五类存储介质

|介质|存放内容|位置|理由|
| ------------------| -------------------------------------------------------------| --------| -----------------------------|
|**SQLite**（better-sqlite3）|会话消息、conversation 记录|userData|量大、需查询、需事务|
|**electron-store**（JSON）|settings、UI state、项目/会话元数据|userData|小体量、需人工可读可改|
|**文件系统**|skills / plugins / commands / agents / snippets / automations|`~/<scopedDataFolderName>/`|与 CLI 共享、Agent 可直接读写|
|**远程 Gateway**|云端会话/项目/设置|远端|`remoteStorageEnabled=true` 时启用|
|**内存**|Agent 运行态、stream 映射、临时缓存|—|进程生命周期|

### 13.2 用户数据目录全景

```
~/<dataFolderName>/[<scopeSegment>/]        ← scopeSegment 支持多账号隔离
├── settings.json                  全局设置（含 enabledPlugins / lockedSkillPaths）
├── skills/
│   ├── skills-market/             对内市场
│   └── skills-market-external/    对外市场
├── skills-disabled/               legacy 禁用目录
├── .skills-tmp/                   更新暂存（与 skill 同文件系统，避免 EXDEV）
├── .disabled-skills.json          禁用元数据
├── plugins/
│   ├── installed_plugins.json
│   ├── known_marketplaces.json
│   ├── cache/{market}/{name}/{version}/
│   └── marketplaces/{name}/
├── commands/                      自定义 Slash 命令
├── snippets/                      Raycast 式片段
├── mcp/                           MCP 配置
├── memory/                        Memory MCP 数据
├── agents/                        SubAgent 配置
├── desk/
│   ├── automations/               定时任务
│   └── sso_config.json            账号级 SSO
├── desk_default_workspace/        默认工作区
└── sso_config.json                共享 SSO（不随账号 scope）

~/<cliFolderName>/                 ← 可与上面不同（distro 场景）
├── bin/                           CLI wrapper / symlink
├── <cliCommandName>.sock          CLI IPC socket（Windows 为命名管道）
└── logs/                          日志

<workspace>/<dataFolderName>/[<scope>/]
├── skills/                        工作区级技能
└── agents/                        工作区级 SubAgent
```

### 13.3 三个关键设计

#### ① 暂存目录与目标同文件系统

```ts
export function getSkillUpdateTmpDirFromPath(skillDir: string): string {
  const parsed = parseSkillDataPath(skillDir)
  if (parsed) return path.join(parsed.dataRoot, '.skills-tmp')   // ← 同 dataRoot
  return getSkillsTmpDir()
}
```

注释点明目的：

> 无论用户级（`~/<scoped>/`）还是工作区级（`{ws}/<scoped>/`）都能工作，保证暂存目录与 skill **在同一文件系统**上（这样 `fs.rename` 不会撞 EXDEV）。

**下载-然后-交换（download-then-swap）**  的原子更新模式，前提是 rename 不跨设备。

#### ② 共享 vs 账号隔离的区分

```ts
getSharedUserDataDir()   // ~/<dataFolderName>/         永不按账号分片
getUserDataDir()         // ~/<dataFolderName>/<scope>/ 按账号分片
```

`sso_config.json` 有两份：共享的（`getSharedSsoConfigPath`）与账号级的（`getLocalSsoConfigPath`）——共享的用于"当前登录的是哪个账号"，账号级的存该账号的凭据。这是多账号切换必须的双层结构。

#### ③ 元数据文件名也随品牌派生

```ts
getSkillMetaFilename()        // `${dataFolderName}-meta.json`         → .catpaw-meta.json
getSkillInstallMetaFilename() // `${dataFolderName}-install-meta.json`
```

连元数据文件名都不硬编码，保证两个 CatDesk-family 产品的 skill 目录可以共存而不互相误读。

### 13.4 会话消息的三级降级加载

```ts
loadSession(sessionId): Promise<LoadSessionResult>
// 三级降级：memory → SQLite → needs_server_history
```

1. **memory**：主进程 `sessionMessageStore` 里有 → 直接返回
2. **SQLite**：本地持久化里有 → 读出并回填 memory
3. **needs_server_history**：本地没有 → 通知渲染层去拉服务端历史

配套的**订阅与广播**协议：

```ts
addActiveSession(sessionId)     // 标记窗口正在订阅，主进程触发一次 `replace` 全量广播
removeActiveSession(sessionId)  // 取消订阅（多窗口下避免重复广播）
```

这是"**订阅即拉快照**"模式——窗口订阅时主进程主动推一次全量，之后只推增量。配合 `useBridgeEvent` 的 `onSubscribed` 就能彻底消除事件丢失窗口。

### 13.5 一个同步 IPC 的例外

```ts
/**
 * 同步追加用户消息 (sendSync)。
 * 主进程会立即调用 converter.markUserMessageSent()，跳过后续 SSE 的 user_message echo。
 * 同步调用可消除 async invoke 的微任务间隙，防止 echo 事件先于标志位被处理。
 */
appendUserMessageSync: (sessionId, message): boolean =>
  getElectronAPI()?.appendUserMessageSync?.(sessionId, message) ?? false
```

全仓几乎所有 IPC 都是异步 `invoke`，这里是**唯一刻意用同步 **​**​`sendSync`​** 的地方。理由是竞态：异步 invoke 会让出一个微任务，而 SSE 的 `user_message` echo 可能恰在这个间隙到达，此时 `markUserMessageSent()` 标志位还没设上，echo 就会被当成新消息上屏造成重复。

**同步 IPC 会阻塞渲染进程，是要极力避免的**——但当"消除微任务间隙"本身就是需求时，它是唯一正确的工具。这种例外必须像这里一样写明理由。

---

## 十四、可观测性、诊断与容错

### 14.1 三层可观测性

```
┌─ 日志（Logs）─────────────────────────────────┐
│ main.log / renderer.log / agent.log            │
│ conversations/{convId}.log                     │
│ 自动轮转 + 启动清理（50 文件 / 7 天）           │
├─ 指标（Metrics）──────────────────────────────┤
│ 主进程 → metricBridgeReporter → 渲染层 →       │
│ handleMainProcessMetricSlot → Owl/Raptor       │
│ UPDATE_FAILURE / js.uncaught.count / ANR / …   │
├─ 追踪（Traces）───────────────────────────────┤
│ CPU Profile · Heap Snapshot · Chromium Trace   │
│ diagnosticsOrchestratorService 一键采集         │
└────────────────────────────────────────────────┘
```

指标从主进程"绕行"渲染层再上报，是因为 Owl/Raptor SDK 是浏览器端 SDK。`telemetrySlots` 保证 OSS 下这条链路全是 noop。

### 14.2 渲染层可观测性的"不加重卡顿"原则

`main.tsx` 里对 `initClientObservability()` 的注释是一段很好的性能自证：

> 即使后续 UI 卡顿、CPU 飙高，本调用也能安全完成：
>
> - 入口本身只做一次性事件订阅，**零持续开销**；
> - **被动观测**（PerformanceObserver / window error）由 Chromium 调度器驱动，回调在主线程"有空"时投递，**不会让卡顿更卡**；
> - **主动采样**（DOM 节点数 / 内存读数）使用尾置 `setTimeout` + `requestIdleCallback`，在主线程繁忙时**自动退避**，绝不抢占 UI 线程；
> - 真正"重"的诊断（CPU profile / Heap snapshot / Chromium trace）**不在渲染侧**——那些都跑在主进程，由 `diagnosticsOrchestratorService` 触发，对渲染线程几乎零影响。

 **"观测工具本身不能成为性能问题"**  ——这条原则被逐条论证，而不是空喊。

三个初始化的顺序也有讲究：

```ts
initTelemetry()            // 1. 最前，捕获早期错误
initClientObservability()  // 2. React 渲染前，覆盖启动期错误
initExpertLogoResolver()   // 3. 给 normalizer 提供同步查询
```

`initExpertLogoResolver` 的理由：让历史消息**在入 store 前**一次性补齐 `chip.thumbnailUrl`，避免渲染层每次遍历查找。这是"**把计算前移到数据入口**"的优化。

### 14.3 内存与 CPU 指标：跨平台口径统一

`memoryMetricsService` 里对内存口径的处理很专业：

```ts
/**
 * - Windows：workingSetSize 含大量共享页（DLL/字体等），整机汇总会严重虚高；
 *   privateBytes 为进程独占内存，更接近 Activity Monitor / 任务管理器口径，故优先。
 *   privateBytes 缺失（0）时回退 workingSetSize。
 * - macOS / Linux：沿用 workingSetSize。
 */
function procMemoryKB(metric: Electron.ProcessMetric): number {
  const privateBytes = metric.memory.privateBytes ?? 0
  if (process.platform === 'win32' && privateBytes > 0) return privateBytes
  return metric.memory.workingSetSize
}
```

CPU 的采样方式也纠正了一个常见错误：

```ts
/**
 * cli 上次累计 CPU 时间采样（pid → { 累计 cpuTimeSec, 采样时刻 ms }）。
 * 用于算窗口内 CPU%（Δcputime/Δwalltime）——
 * ps pcpu 是全生命周期平均、长存活 cli 恒≈0，不可用。
 */
private prevCliCpuSample = new Map<number, { cpuTimeSec: number; atMs: number }>()
```

**​`ps`​**​ ** 的 **​**​`pcpu`​**​ ** 是进程生命周期平均值**，对长存活进程几乎恒为 0，必须用两次采样的差分才能得到窗口内真实 CPU 占用。

阈值定义：

```ts
CPU_WARNING_THRESHOLD_PERCENT = 60      // 单进程 60s 平均 CPU
EVENT_LOOP_DELAY_P99_WARNING_MS = 100   // 事件循环延迟 P99
ANR_BLOCK_THRESHOLD_MS = 3000           // 主线程单次阻塞 > 3s = ANR
```

ANR 用 **max 而非 p99** 的理由：

> 单次 3s+ 卡死会体现在 max，而 60s 窗口的 p99 可能被稀释。

#### 自适应采样频率

```ts
/**
 * 异常态密采截止时间戳（ms epoch）。超过此时间戳后自动回到 60s 常规周期。
 * 检测到任一异常（CPU 高 / 内存高 / ELD P99 高）时重置为 `now + INTENSIVE_DURATION_MS`。
 * V2：刻意放在实例字段而非模块级变量，避免破坏单例封装 / 阻碍 dispose 清理。
 */
private intensiveUntil = 0
```

**正常时低频采样省资源，异常时自动密采抓现场**——这是生产环境诊断的最佳实践。

### 14.4 容错设计清单

|场景|机制|位置|
| --------------------------| ----------------------------------------| ---------------|
|asar 损坏（更新失败）|bootstrap 早期守卫 + 友好弹窗 + 下载链接|`bootstrap.ts`|
|preload 缺失|Bridge 全线降级为安全默认值|`bridge/shared.ts`|
|React 渲染崩溃|`<ErrorBoundary>` 包裹整个 App|`main.tsx`|
|IPC 订阅回调抛错|`useBridgeEvent` 的 try/catch|`useBridgeEvent.ts`|
|命令 handler 抛错|`commandRegistry.execute` 捕获，返回 true 不打断派发循环|`commandRegistry.ts`|
|订阅者抛错|所有 `notify()` 循环内逐个 try/catch|三个 Service|
|Agent 崩溃|独立子进程，不影响宿主|进程隔离|
|FFI 死锁|utilityProcess 隔离 + kill 收割|`keyboardHelperHost.ts`|
|`automation.json` 被 Agent 写坏|watcher 校验 + 快照回滚 + 错误精确投递|`folderAutomationWatcher.ts`|
|存储早期未就绪|`resolveMode()` 兜底 `RUN_MODE.LOCAL`|各 bridge index|
|云端连接 lifecycle 错误|降级为 null（区别于业务错误的 throw）|`cloudHandlers`|
|Windows mutex 原生依赖缺失|降级到文件标记 + 轮询超时|`updater/shared.ts`|
|预览 tab 撑爆内存|全局 LRU 淘汰 + 停 watcher|`previewService.ts`|
|SSE 事件在订阅前丢失|`onSubscribed` + 主进程 replay 广播|`useBridgeEvent`|
|多窗口事件串扰|`streamId → sessionId` 归属校验|`useAgentEventHandler`|

---

## 十五、安全设计

### 15.1 Electron Fuses

```json
"electronFuses": {
  "runAsNode": true,
  "enableCookieEncryption": false,
  "enableNodeOptionsEnvironmentVariable": false,
  "enableNodeCliInspectArguments": false,
  "enableEmbeddedAsarIntegrityValidation": true,
  "onlyLoadAppFromAsar": true
}
```

|Fuse|值|安全意义|
| ----| ----| ----------------------------------------|
|`enableNodeOptionsEnvironmentVariable`|**false**|阻止通过 `NODE_OPTIONS` 环境变量注入启动脚本|
|`enableNodeCliInspectArguments`|**false**|阻止 `--inspect` 附加调试器窃取内存数据|
|`enableEmbeddedAsarIntegrityValidation`|**true**|asar 完整性校验，防篡改|
|`onlyLoadAppFromAsar`|**true**|只从 asar 加载，防止旁路放置同名目录劫持|
|`runAsNode`|true|保留——CLI 与 utilityProcess 需要|

`runAsNode: true` 是有意识的权衡：它降低了一点安全性（`ELECTRON_RUN_AS_NODE` 可用），但 CLI 子进程与 keyboard-helper utilityProcess 都依赖它。

### 15.2 进程隔离与上下文隔离

- **contextIsolation**：渲染层拿不到 Node API，只能通过 `contextBridge` 暴露的 `window.electronAPI`
- **API 白名单**：preload 显式列举每个方法，无通配转发
-  **​`<webview>`​**​ ** 严格受限**：仅 CloudTerminalPanel 一处使用，且需主窗口显式开启 `webviewTag`
- **自定义协议特权最小化**：`catpaw-local` 只开 `stream` / `supportFetchAPI` / `corsEnabled`，不开 `allowServiceWorkers`；`wenshu-sw` 才开（因为要跑 SW）

### 15.3 账号数据隔离

`parseSkillDataPath()` 的注释是一条显式的安全边界声明：

> 从**活跃账号的精确数据树**解析 skill 路径。属于其他账号或旧的 unscoped 工作区树的路径**不匹配**；调用方**不得静默跨越账号边界**。

配合 `createScopedStore` 把渲染层配置也落到主进程的 scoped store，做到**切换账号后零残留**。

### 15.4 Safe Room（安全屋）

```ts
buildSafeRoomShellEnv(sessionId, enableSafeHouse)
// → { IS_SAFE_ROOM_AGENT, DAXIANG_SAFE_ROOM_TOKEN, … }
```

安全屋是敏感数据处理的隔离环境。JWT 经 `shellEnv` provider 注入 Agent 子进程环境变量；`safeRoomTokenBrowserPlugin` 则把 token 以 `window.SAFE_ROOM_TOKEN` 注入**指定的内部 BI 域名**（`bi.sankuai.com` / `bi.meituan.com`）——注入目标是白名单而非通配。

对无安全屋后端的 distro，`safeRoomSlot.enabled = false` 会**完全短路**整条链路，连 token 请求都不发。

### 15.5 输入校验与路径安全

- **zod schema**：所有外部 JSON（plugin.json / marketplace.json / automation.json）强校验
- **​`validateDirName.ts`​**：目录名校验，防路径穿越
- **​`pathValidation`​**​ ** / **​**​`pathCompare`​**（`@shared/utils`）：路径归一化与安全比较
- **​`sanitizeDraft`​**​ ** / **​**​`sanitizeEditorContextStates`​**：用户输入清洗
- **​`dompurify`​**：Markdown 渲染的 XSS 防护
- **​`trafficSafeGuard`​**：流量保护，防止异常请求风暴

### 15.6 macOS 权限声明

```json
"extendInfo": {
  "NSMicrophoneUsageDescription": "CatDesk 需要使用麦克风来支持语音输入功能",
  "NSAccessibilityUsageDescription": "CatDesk 需要辅助功能权限来支持全局快捷键语音输入"
}
```

只声明真正需要的两项权限，并给出用户可理解的中文说明。

---

## 十六、构建、打包与发布

### 16.1 构建产物

```
dist/                     渲染进程（Vite 产物）
dist-electron/            主进程 + preload
├── main-*.js             主进程 bundle（扁平单文件）
├── preload.js
└── cliMain.js            → 打包为 resources/cli/catpaw-cli.js
release/                  electron-builder 输出
```

注意 `pluginPaths.ts` 里的一条说明：

> dev 模式下 `app.getAppPath()` 直接返回项目根。用 `import.meta.url` 不可靠，因为 **vite 把所有 electron 代码打成一个扁平文件**（`dist-electron/main-xxx.js`），相对路径回溯（`../../`）与原始源码布局对不上。

这是 Electron + Vite 组合下的常见陷阱。

### 16.2 体积优化：`files` 白名单/黑名单

`electron-builder.json` 的 `files` 数组有 100+ 条规则，分三类：

**① 排除已被 Vite 打进 bundle 的渲染依赖**（避免双份）

```
!**/node_modules/**/react/**            !**/node_modules/**/monaco-editor/**
!**/node_modules/**/zustand/**          !**/node_modules/**/mermaid/**
!**/node_modules/**/@radix-ui/**        !**/node_modules/**/shiki/**
!**/node_modules/**/@catpaw/ui-react/** !**/node_modules/**/katex/**
```

**② 排除开发时依赖**

```
!**/node_modules/**/vite/**       !**/node_modules/**/typescript/**
!**/node_modules/**/vitest/**     !**/node_modules/**/eslint*/**
!**/node_modules/**/@types/**     !**/node_modules/**/tailwindcss/**
```

**③ 排除原生模块的源码/构建产物**

```
!**/node_modules/**/koffi/src/koffi/src/**/*.{cc,hh,inc,S,asm,def}
!**/node_modules/**/koffi/vendor/**       !**/node_modules/**/koffi/doc/**
!**/node_modules/**/node-pty/src/**       !**/node_modules/**/node-pty/deps/**
!**/node_modules/**/better-sqlite3/deps/** !**/node_modules/**/better-sqlite3/src/**
```

还有 lodash 的**精确白名单**——先排除所有 `lodash*`，再显式包含 4 个真正用到的：

```
"!**/node_modules/**/lodash*/**",
"**/node_modules/lodash/**",
"**/node_modules/lodash.identity/**",
"**/node_modules/lodash.merge/**",
"**/node_modules/lodash.pickby/**"
```

以及全局清理 `.d.ts` / `.map` / `README` / `LICENSE` / `tsconfig*.json` / `binding.gyp` / CI 配置。

### 16.3 `asarUnpack`：必须落在真实文件系统的模块

```json
"asarUnpack": [
  "**/node_modules/koffi/**/*",              // FFI 需要 dlopen 真实路径
  "**/node_modules/@koromix/**/*",
  "**/node_modules/better-sqlite3/**/*",     // 原生 .node
  "**/node_modules/node-pty/**/*",           // 原生 .node + spawn helper
  "**/node_modules/sharp/**/*",              // 原生 libvips
  "**/node_modules/@img/**/*",
  "**/node_modules/@ffmpeg-installer/**/*",  // 可执行二进制
  "**/node_modules/@vscode/windows-mutex/**/*",
  "**/node_modules/agent-browser/**/*",
  "**/node_modules/bindings/**/*",
  "**/node_modules/file-uri-to-path/**/*",
  "**/node_modules/@mtfe/mtsso-auth-official/**/*",
  "**/node_modules/@catpaw/agent-sdk/**/*"   // 需被 spawn 执行
]
```

判断标准很清晰：**任何需要 **​**​`dlopen`​**​ ** 加载、**​**​`spawn`​**​ ** 执行、或读取真实文件路径的模块**都必须 unpack——asar 是虚拟文件系统，这些操作在其中会失败。

`@catpaw/agent-sdk` 被 unpack 但同时排除其嵌套的 `typescript` / `tsx` / `@esbuild` / `@types`——只留运行时需要的部分。

### 16.4 三平台产物

|平台|目标|最低版本|备注|
| -------| ----| --------| ---------------------------|
|macOS|`zip`|13.0|`identity: null`（OSS 不签名）；分类 `developer-tools`|
|Windows|`nsis` + `zip`|—|NSIS 非一键、允许改安装目录|
|Linux|`AppImage` + `deb`|—|分类 `Development`|

macOS 用 `.zip` 而非 `.dmg` 是为了配合 **Squirrel.Mac 自动更新**（它要求 zip 格式）。

### 16.5 `extraResources`：随包分发的非 JS 资源

```json
skills → skills                                       内置技能
.build/remote-skills → skills                         构建期下载的远程技能（与上面合并）
build/icon.png / tray-iconTemplate[@2x].png           图标
native/keyboard-helper/build/libKeyboardHelper.dylib  自研原生库
dist-electron/cliMain.js → cli/catpaw-cli.js          CLI 入口
packages/token-exchange/bin/... → token-exchange/...  Token 交换工具
resources/wenshu-plugin → wenshu-plugin               Chrome 扩展源码
```

`skills` 与 `.build/remote-skills` **合并到同一个目标目录**，实现"本地内置 + 构建期远程拉取"的统一分发。

### 16.6 `afterPack` 钩子

```json
"afterPack": "./scripts/afterPack.cjs"
```

从 `bootstrap.ts` 的注释可知它负责把 `product.json` 写到各平台的正确位置：

```
Windows packaged : …/resources/product.json          （asar 同级）
macOS packaged   : …/Contents/Resources/app/product.json
Linux packaged   : …/resources/app/product.json
Dev              : <repo>/product.json
```

**必须写在 asar 外**，这样 asar 损坏时 bootstrap 仍能读到下载地址。

### 16.7 pnpm 原生模块编译白名单

```yaml
onlyBuiltDependencies:
  - '@catpaw/agent-sdk'
  - '@catpaw/ripgrep'
  - '@swc/core'
  - electron
  - electron-winstaller
  - esbuild
  - tree-sitter-bash
```

pnpm 默认禁止依赖执行 install 脚本（供应链安全），这里显式白名单放行必需的几个。同时 `"npmRebuild": false` 表示原生模块的 Electron ABI 重建由独立流程处理，不在 electron-builder 阶段做。

---

## 十七、测试策略

### 17.1 规模与分布

**168 个测试文件**，覆盖主进程与渲染进程：

|区域|测试重点|代表|
| -----------------| --------------------------------------------------------| --------------|
|主进程 base|路径解析|`dataPathService.test.ts`|
|主进程 plugin|发现/路径/设置/并发/市场/更新|15 个测试文件|
|主进程 skills|fs / 导入 / 元数据 / 路径 / 开关 / 更新|6 个测试文件|
|主进程 automation|schema / 服务 / 调度同步 / store / watcher / rrule|6 个测试文件|
|主进程 system|文件上传 / 图片压缩 / 设置副作用 / 更新版本 / 窗口背景|5 个测试文件|
|渲染 platform|commandRegistry / contextkeyParser / keybindingService|3 个测试文件|
|渲染 stores|各 slice 独立测试|10 个测试文件|
|渲染 hooks|24 个测试文件|—|
|渲染 components|ChatAreaV2 隔离/会话隔离/mention/slash/错误恢复/历史导航|12+ 个测试文件|
|i18n|**翻译完整性守卫**|`i18nGuard.test.ts`|

### 17.2 Vitest 配置的两处经验修复

`vitest.setup.ts` 里有两段带完整踩坑记录的配置：

**① jest-dom 匹配器显式 extend**

```ts
// vitest 4 下 `@testing-library/jest-dom/vitest` 的自扩展副作用在某些 workspace/
// 多 project 配置里落不到本项目的 expect 实例上，导致 `toBeInTheDocument` 等
// 匹配器全部报 "Invalid Chai property"（renderer 项目下 64+ 个测试受影响）。
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
expect.extend(jestDomMatchers)
```

**② 全局 cleanup**

```ts
// Vitest 不像 Jest 那样自动清理 @testing-library，没有这个的话一个测试挂载的组件
// 会把它的 in-flight effects / async requests 带进下一个测试，消耗排队的
// mockResolvedValueOnce 值并污染无关的 spec（表现为跨测试的 flaky 失败，
// 例如 usePluginsData 看到过期的 page 响应）。
afterEach(() => { cleanup() })
```

**③ Vitest 4 的构造函数 mock**

```ts
// vitest 4 重写了 spying：用 `new` 调用的 mock 必须由 function/class 实现支撑
//（箭头函数不可构造）。
global.ResizeObserver = vi.fn(function (this: unknown) { … })
```

### 17.3 默认不注入 electronAPI

```ts
Object.defineProperty(window, 'electronAPI', { writable: true, value: undefined })
```

这是**故意的**：让所有组件测试**默认跑在 Bridge 降级路径上**。这带来两个好处：

1. 组件测试不需要 mock 庞大的 electronAPI 就能跑
2. **每次组件测试都在顺带验证降级逻辑**——如果某个 bridge 方法忘了写 `?? 默认值`，测试会立刻崩

需要真实 IPC 行为的测试再按需注入。这是 G4（防御式降级）能长期保持的机制保障。

### 17.4 i18n 守卫测试

`i18n/__tests__/i18nGuard.test.ts` + `i18nGuardShared.ts` 自动校验 `zh-CN` 与 `en` 两个 bundle 的 key 集合一致，防止加了中文忘了加英文。

### 17.5 值得学习的测试用例命名

从文件名就能看出这些测试在守护什么**具体的历史 bug**：

```
ChatAreaV2/__tests__/isolation.test.ts           多实例隔离
ChatAreaV2/__tests__/sessionIsolation.test.tsx   跨会话状态不串
ChatAreaV2/__tests__/errorRecovery.test.tsx      错误恢复路径
ChatAreaV2/__tests__/historyNavigation.test.tsx  历史导航
plugin/__tests__/marketplacePluginService.concurrent.test.ts   并发写
automation/__tests__/folderAutomationWatcher.test.ts           防篡改
```

**测试名描述"防止什么退化"，而不是"测什么函数"**  ——这让测试成为活文档。

---

## 十八、架构权衡（Trade-offs）与演进方向

### 18.1 已做的权衡

|决策|收益|代价|判断|
| ----| -------------------------------------| --------------------------------------| --------------------------------------------------|
|**70+ Slots 扩展点**|OSS/distro 零 fork 分叉，可维护多租户|认知负担；改行为要同时想 OSS 与 distro|✅ 值得——多租户是硬需求，fork 分叉的长期成本远高|
|**Local/Cloud 双 Bridge**|UI 代码复用率极高|每个能力要写两遍实现|✅ 值得——接口层薄，实现本就不同|
|**单 Zustand Store + 40 slice**|无 Provider 嵌套、跨 slice 读取方便|store 类型巨大；slice 间无强隔离|⚠️ 可接受——但 slice 数量再涨要考虑拆分|
|**会话真值在主进程**|多窗口天然一致；崩溃可恢复|每次更新一次 IPC；需节流合批|✅ 值得——多窗口是核心场景|
|**Hash 路由多形态窗口**|单 bundle，构建简单|所有窗口加载完整 JS；靠 `MainWindowApp` 隔离副作用|⚠️ 可接受——已通过组件边界隔离缓解|
|**koffi utilityProcess 隔离**|主进程绝不被 FFI 卡死|多一个进程；跨进程消息开销|✅ 值得——死锁的代价是整个应用假死|
|**​`chatInputSlots`​**​ ** 用构建时常量**|可 tree-shake|无法运行时切换|✅ 值得——租户在构建时就确定|
|**ChatArea 与 ChatAreaV2 并存**|平滑迁移，可灰度回滚|两套渲染链路同时维护|⚠️ 临时状态——应有明确的下线时间点|
|**​`appendUserMessageSync`​**​ ** 用同步 IPC**|消除 echo 竞态|阻塞渲染进程（极短）|✅ 值得——但必须是唯一例外|

### 18.2 可识别的技术债

#### 债务 1：ChatArea v1 / v2 双链路

```
src/components/ChatArea/    (v1，@catpaw/ui-react)
src/components/ChatAreaV2/  (v2，@catpaw-ui/render-react)
```

路由由 `uiSdkForceRefresh`（灰度）+ `conversationMode` + `CHAT_INPUT_FORCE_V2`（slot）+ `isCloudSession` 四个条件共同决定，优先级链条已经比较复杂。`#/diff-demo` 页面的存在说明团队在系统性地验证迁移正确性，方向是对的，但**需要明确的 v1 下线时间点**。

#### 债务 2：service 层反向依赖 store

```ts
// FIXME(Phase 3 cleanup): service 不应直接依赖 stores/，后续需把 store 依赖改为参数注入
// eslint-disable-next-line import-x/no-restricted-paths
import { useCatDeskStore } from '../stores/catDeskStore'
```

`previewService` 里有 3 处这样的标注。已用 ESLint 规则（`import-x/no-restricted-paths`）**把约束显式化**并逐个 disable 标记，属于"**受控的技术债**"——比无声违反好得多。

#### 债务 3：SDK 版本滞后的临时类型

`cloudChannel.ts` 里有两处"临时本地类型"（`archive/unarchive`、`getSubSessions`），都写明了删除条件。属于良性债务，但需要跟踪。

#### 债务 4：`__petDebug` 挂在全局 window

```ts
;(window as any).__petDebug = { update, remove, clear, devtools, demo }
```

这段调试代码在 `bridge.ts` 里**无条件**注入所有渲染窗口，生产环境也存在。建议用 `import.meta.env.DEV` 包裹。

### 18.3 演进方向建议

**近期（1–2 个迭代）**

1. **确定 ChatArea v1 下线时间表**——双链路是当前最大的复杂度来源
2.  **​`__petDebug`​**​ ** 加 DEV 守卫**——一行改动，降低生产面
3. **完成 service → store 的依赖倒置**——把 store 依赖改为参数注入，让 `previewService` 可独立测试

**中期（3–6 个月）**

4. **Store 分域**：40+ slice 在单 store 里，`CatDeskState` 类型已相当庞大。可考虑按 `workspace` / `chat` / `ui` / `cloud` 拆成 3–4 个独立 store，用组合而非合并
5. **Slot 契约的自动化校验**：写一个构建期检查，验证 distro 的每个 shadow 文件都实现了 OSS 对应 `*Slots.types.ts` 的完整契约，防止漏实现在运行期才暴露
6. **Provider Registry 的类型化增强**：目前 `registerProvider('key', impl)` 的 key 是字符串字面量，可用映射类型让 key 与 impl 类型强绑定，杜绝注册错类型
7. **IPC 契约的运行时校验**：目前跨进程只有编译期类型保障，考虑在 DEV 模式下给关键 channel 加 zod 校验，捕获 preload/handler 的实现漂移

**长期**

8. **Feature 裁剪的 CI 验证**：为 G1（可裁剪）建立自动化验证——CI 里随机删除若干 feature 目录后跑构建，确保不 break。目前这条铁律靠人工遵守
9. **多窗口按需分包**：Quick Chat / Pet Overlay 加载完整 bundle 仍是浪费，可探索按路由分包（Vite 多入口），进一步压低唤起延迟与常驻内存
10. **Cloud 模式的能力对齐度量**：建立一张 local/cloud 能力矩阵并持续测量，避免 cloud 分支长期落后成为"二等公民"

### 18.4 这套架构最值得借鉴的五点

**1. 「零成本抽象」的扩展点设计**

`dataPathScopeSlot` 是范本——OSS 下 `path.join(home, '.catpaw', '')` 塌缩为原路径，**行为、路径、性能完全不变**。扩展点不应该让默认路径付出任何代价。

**2. 注释即设计文档**

几乎每个关键文件的头部注释都包含：**要解决什么问题 → 为什么这么设计 → 被拒方案 → 不变量 → 何时可以删除**。`bootstrap.ts` 的 ESM 提升分析、`logFileService` 的 console hook 顺序不变量、`cloudAgentChannel` 的缓存生命周期推理——这些是团队真正的知识资产。

**3. 用类型系统编码运行时事实**

`LocalPluginEntry`（已校验为本地路径）、`z.infer` 反推类型、`typeof preload` 作为 IPC 契约——把"已验证"、"已约定"的事实固化到类型里，让下游不必重复检查。

**4. 降级策略按语义逐个决定**

不是"全部返回 null"，而是 `send` 必须 reject、`stop` 静默成功、`getStatus` 返回安全快照、`tryResendPendingInput` 返回 null 触发回退。**每个降级值都编码了调用方应有的行为**。

**5. 性能优化建立在测量与推理上**

`MainWindowApp` 隔离（修 Quick Chat 常驻 CPU）、分阶段并行启动（200-800ms → max）、动态唤醒替代 30s 轮询、节流广播（全量快照只需最新帧）、自适应采样频率、`procMemoryKB` 的跨平台口径统一——每一处都有明确的问题陈述和收益说明，而非凭感觉优化。

---

## 附录 A：关键文件索引

|关注点|入口文件|
| -------------------------| --------|
|主进程启动与崩溃守卫|`electron/bootstrap.ts`|
|产品配置（品牌/行为开关）|`electron/services/base/productService.ts`|
|所有路径解析|`electron/services/base/dataPathService.ts`|
|日志体系|`electron/services/base/logFileService.ts`|
|IPC 聚合出口|`src/bridge/bridge.ts`|
|IPC 降级基础|`src/bridge/shared.ts`|
|IPC 类型契约|`src/vite-env.d.ts`|
|事件订阅规范|`src/hooks/useBridgeEvent.ts`|
|渲染进程入口|`src/main.tsx` → `src/App.tsx`|
|状态装配与启动编排|`src/stores/catDeskStore.ts`|
|Slice 注册契约|`src/stores/slices/registry.ts`|
|命令注册表|`src/platform/commands/commandRegistry.ts`|
|快捷键派发|`src/platform/keybinding/keybindingService.ts`|
|上下文键|`src/platform/contextkey/contextKeyService.ts`|
|Agent 通道抽象|`src/services/agent/IAgentChannel.ts`|
|对话 Facade|`src/hooks/useConversation.ts`|
|Agent 事件处理|`src/hooks/useAgentEventHandler.ts`|
|文件预览编排|`src/services/previewService.ts`|
|打包配置|`electron-builder.json`|
|依赖锁定|`pnpm-workspace.yaml`|
|测试环境|`vitest.setup.ts`|

## 附录 B：术语表

|术语|含义|
| ----| -----------------------------------------------------------------|
|**Distro**|基于 OSS 内核的下游定制版本（internal / external(CatX) / 私有化）|
|**Slot**|`*Slots.ts` 扩展点文件，distro 可通过同路径同名文件影子覆盖|
|**Shadow**|distro 覆盖 OSS 文件的机制，由 `distroResolvePlugin` 在构建时解析|
|**runMode**|运行模式，`local`（本机 Agent）或 `cloud`（远端 Desk）|
|**Desk**|一个 CatDesk 实例；cloud 模式下本机作为 Channel 连接远端 Desk|
|**Pike**|长连接推送协议，用于 cloud 模式的 RPC 与事件|
|**Skill**|能力包，含 `SKILL.md` + 脚本 + 资源，Agent 可按需加载|
|**Plugin**|容器扩展，打包 skills / MCP servers / commands / subagents|
|**MCP**|Model Context Protocol，标准化的工具服务器协议|
|**Subagent**|子代理，主 Agent 可委派任务的专门化代理|
|**Artifact**|Agent 产出物（文件/代码/文档）|
|**Safe Room（安全屋）**|敏感数据处理的隔离环境，JWT 授权|
|**Automation**|定时/事件触发的无人值守 Agent 任务|
|**Quick Chat**|Raycast 风格的全局唤起输入窗（Command+J）|
|**Popout**|从主窗口分离出的独立会话窗口|
|**Pet Overlay**|桌面宠物悬浮层，被动展示会话状态|
|**Wenshu（文书）**|美团内部下载插件，以 Chrome 扩展形式集成|
|**Horn**|配置下发/灰度开关服务|
|**Owl / Raptor / LX**|美团内部的 APM / 指标 / 埋点平台|
|**CIBA**|Client-Initiated Backchannel Authentication，端上确认的授权流|
