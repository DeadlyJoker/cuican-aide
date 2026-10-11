# 插件页面与 Agent 会话的宿主边界

插件的页面统一进入右侧工作台，中间保留 CrewON 原 Agent 会话及其输入框。这里调整的是宿主的展示位置，不改变插件安装、权限、任务或工作空间协议；业务插件仍须由真实安装目录提供。

## 实际接线

`useInstalledPluginModules` 继续从当前安装目录生成 `CommandWorkspaceHostModule`。`InstalledPluginModule` 和 `PluginModuleMount` 继续负责授权租约、加载、更新、取消与清理。

`CommandWorkspace` 保留现有模块选择和生命周期检查。新增 `CommandWorkspacePluginPanel` 把模块内容通过 React portal 挂到 `AppCommandShellRoute` 唯一的 `CommandWorkspaceCapabilityDrawer` 内容节点。传给 Route 的对象只包含宿主选择的模块标识、标题和关闭回调；插件只收到原来的 UI props，没有获得导航、账号、HTTP client 或窗口管理权限。

现有贡献槽 `main.content` 保持兼容。它表示插件的内容挂载点，不授权插件替换应用外壳；宿主可以把这个内容挂载点放在右栏。

## 会话与导航

打开插件时，中间显示当前已选中的原 Agent 会话，或者原新任务首页。会话标题、模型选择、输入草稿、资源入口、权限选择、发送、停止和流式渲染继续由原组件与运行时管理。插件页不创建另一套聊天框。

左栏保留中间会话的工作空间上下文，同时保留所选插件的目录高亮。插件打开不会重设执行目标、模型或已绑定的工作空间。真正切换会话、场景、账号 owner、导航页面，或目录撤回，仍沿用现有失效检查；相同页面的 hash 投影不视为离开插件，popstate 仍撤回选择。

项目工作空间的持久归属和插件/项目隔离属于现有工作空间与项目服务的职责。本次 UI 变更没有新建目录、迁移旧 Thread 或重写旧 Run，也不把 UI 选择作为工作空间或任务授权。

## 右栏行为

- 复用原工作台宽度、拖拽与键盘调宽能力，正常窗口通过 grid 缩小中间可用宽度。
- 插件选中时暂时隐藏原工具内容，保留已打开的工具组件与状态；关闭插件后恢复原工具栏，不调用其关闭回调。
- 隐藏的工具不抢占插件页快捷键。插件标题栏只有标题和关闭，不提供覆盖中间会话的全屏操作。
- 小于 880px 的窗口将会话和插件上下排列，各保留 220px 最小高度；短窗口和横屏中，外层 Route 自动滚动，让第三条轨道和插件底部仍可到达。足够高的窗口不产生额外外层滚动。窗口标题栏继续采用原高度。
- 安装目录读取失败时，只在右栏显示失效与重试提示，撤回旧的可调用模块内容。账号/owner 变化仍清理旧选择。
- 空 Web 插件目录不显示插件面板或桌面工具入口。

TaskDetail 原有窄屏浮层协调继续用于任务详情与工具；它不是插件上下排列的替代方案。插件的布局规则覆盖原工具窄屏固定定位，仍在 Route grid 中占据第三条轨道。

## 本次验证与产物

新增 `CommandWorkspacePluginPanel.test.tsx` 使用真实 `AppCommandShellRoute → CommandWorkspace → CommandWorkspaceCapabilityDrawer` 验证模块打开、切换、关闭、原会话/输入框保留、原工具恢复、调宽、目录失效、空目录和计划导航请求/Escape。标题快照位于同目录 `__snapshots__/CommandWorkspacePluginPanel.test.tsx.snap`。

原 `CommandWorkspaceHostModules.test.tsx` 改为给组件提供宿主右栏节点，并保留账号、会话、场景、目录撤回和独立贡献标识的行为覆盖。`CommandSidebarSearchView.interaction.test.tsx` 对应调整为插件选中时保留原工作空间上下文。

短窗回归使用真实 Route 和生产 CSS，在 640×360、360×320、800×600 三种窗口配置下验证外层滚动、两条 220px 最小轨道、相对定位的第三轨道、插件内滚动和关闭后恢复。加入声明之前，这三例在缺少外层滚动处失败。Happy DOM 能验证媒体查询和 CSS 生效，不测量实际几何尺寸；Web 的真实布局验收仍由主任务进行。

本轮使用 Node 24.19.0 重跑：`tsc -b --noEmit` 通过，窄回归 9 个文件、60/60 通过，UI 生产构建通过。最终产物为 `dist/assets/index-Cql4n8Cu.css`、`dist/assets/index-CCXwfIrN.js` 及 `dist/index.html`。本文件不把组件测试等同于浏览器验收。

同源 Web 预览使用独立的临时静态产物目录，原 Control 与正式 Web 入口保持原样。实际浏览器恢复了原 admin、原会话的 20 行结果、后续回复和 `gpt-6-astra` 选择；打开原工作台后，1280×720 窗口中会话区域为 x=268/宽532，右栏为 x=800/宽480，聊天输入框仍可见，关闭后恢复。目录为空，没有安装或测试真实业务插件，因此该观察只证明基础会话与原工作台仍可共存。浏览器 viewport override 未改变实际 1280×720 尺寸，已 reset；不将其计作窄屏或真实插件面板验收。

按设计回归规范执行完整 `CommandWorkspace` 筛选后，182/186 通过；仍有 4 个未触碰的历史快照失败：`CommandWorkspaceCatalogMvp` 登录/注册两例、`CommandWorkspaceConversation` 未同步终态回复一例、`CommandWorkspaceMultiWorkspace` 旧空间树一例。没有批量更新这些快照，也没有宣称整个 UI 回归通过。
