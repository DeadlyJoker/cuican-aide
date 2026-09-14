# F02 设计与 C01 契约

## 源码事实与接线

`electron/browserViews.ts` 只有 WebContentsView 创建/定位/可见性/销毁，隔离上下文且无 preload。弹窗交给外部浏览器；没有 DOM 或可访问性录制。`electron/preload.ts` 的 browser IPC 同样只有四个操作。`CommandWorkbenchBrowser.tsx` 的地址变化和重载会创建新 view generation，网页版仅 iframe，不能冒充可录制来源。

新增独立 teaching host/source/store，普通 browser manager 保持其原有行为。教学宿主拥有一个 BrowserWindow 和 WebContentsView；本地 React 控制页沿用中性主题，在上方放地址与录制控制，下方分页回看，页面在独立有界区域展示。独立 renderer preload 只暴露录制端口；远程页面 preload 不暴露任何 main-world API。只允许教学控制主框架调用控制 IPC；事件 IPC 同时验证确切 webContents 和顶层 senderFrame，远程页面不能调用控制能力。

页面捕获使用 isolated preload 中受信任的 click/change 与顶层导航观察。选择框 change 表达选择/筛选，文本 change 表达提交的普通输入；不记录每次按键。结构 CSS 路径、角色与经过过滤的安全可访问名称解释对象，不复制整段 DOM/正文。只支持标准 HTML 控件；框架、canvas、弹窗、file、contenteditable 均产生 unsupported。跨源导航暂停并等待用户点击继续授权当前源。

源头排除 password、credential autocomplete、含敏感语义的控件与疑似令牌值，敏感输入只留下 runtime-required 标记、不读取或发送原值；不访问 Cookie、storage、网络正文。普通文本及标识有长度限制与第二道宿主过滤。页面地址保留 origin 和经过过滤的 `routeTemplate`：普通路由保留，敏感或高熵路径段替换 `{runtime}`，query 值全部替换 `{runtime}`；去掉片段、用户信息，保留 `routeDigest` 辅助完整性校验。F03 可复用安全路由并要求运行时补齐参数。关键画面首发为经过安全检查的标准按钮/链接/选择控件局部 PNG；存在敏感输入、嵌套未知内容或无法确认安全时不抓像素，明确显示画面不可采集。输入字段仅用几何图辅助定位，几何图不称为真实截图。不会采集整页像素或正文。原事件与图分离保存；不向模型整段注入录制。

## C01 RecordingExport v1（F02 owner）

权威公开端口拟为 `@crewon/contracts/recording`，文件 `packages/contracts/src/recording-export.ts`；严格 parser 拒绝未知字段/版本、畸形值、重复 stepId、乱序、悬空 evidence、超预算。`validateRecordingExport(value)` 异步校验结构与摘要，返回已校验值或抛错；`sealRecordingExport(body)` 生成摘要。摘要规则：递归排序对象键，数组保序，JSON UTF-8，省略顶层 contentDigest，对其 SHA-256 后前缀 `sha256:`。证据正文独立授权读取，导出不嵌入正文。

```ts
type RecordingExport = {
  schemaVersion: 1;
  recordingId: string;
  revision: number; // 每次已持久化变更递增
  contentDigest: `sha256:${string}`;
  scope: { ownerId: string; workspaceId: string | null };
  authorization: {
    source: "desktop-user-start";
    authorizedAt: string;
    allowedOrigins: string[];
  };
  startedAt: string;
  updatedAt: string;
  status:
    | "recording"
    | "paused"
    | "completed"
    | "interrupted"
    | "budget-exceeded";
  steps: Array<{
    stepId: string;
    sequence: number; // 原始单调序号，删步不重排身份或序号
    kind:
      | "navigate"
      | "click"
      | "input"
      | "select"
      | "download"
      | "unsupported";
    occurredAt: string;
    page: { origin: string; routeTemplate: string; routeDigest: string };
    target: {
      tag: string;
      selector: string;
      description: string;
      role: string | null;
      accessibleName: string | null;
    } | null;
    input:
      | { classification: "ordinary" | "parameter-candidate"; value: string }
      | { classification: "runtime-required" }
      | null;
    note: string | null;
    evidenceIds: string[];
    outcome: "observed" | "completed" | "cancelled" | "unknown";
    reason: string | null;
    relatedStepId: string | null;
  }>;
  evidence: Array<{
    evidenceId: string;
    kind: "redacted-layout" | "redacted-screenshot";
    mediaType: "image/svg+xml" | "image/png";
    byteLength: number;
    contentDigest: string;
  }>;
  edits: Array<{
    revision: number;
    stepId: string;
    operation: "delete" | "annotate";
    at: string;
  }>;
};
```

本地 ownerId 是宿主录制仓库持久化随机身份，不能等同远程 tenant/user 权限；workspaceId 首发为 null。导出带的 scope 为来源声明，F03 导入必须通过已认证入口归属当前 owner/workspace，不能信任该声明赋权。证据读取仅本地 host 按录制 ID + evidence ID 开放；F03 跨进程需要另行授权导入，不读取任意路径。无 HTTP、Control、Worker、Device 变更。新 subpath 为新增私有包入口，旧数据和 API 不变；未知版本拒绝并提示升级。

## 状态、存储与故障

宿主 JSON 文档与 evidence 子目录位于自身 userData/recordings；使用随机 ID、固定文件名、0600 文件和原子 rename，mutation 串行、expectedRevision 乐观锁。最多保留 20 份录制，满额要求用户明确删除旧录制，不自动覆盖。每次 step/control/edit 先写成功再更新 UI；失败关闭采集、报错，保留上次确认快照。当前状态在磁盘为 recording/paused 时宿主重启写为 interrupted；不自动重新浏览或收集。页面崩溃、窗口关闭、源变化关闭 capture generation，迟到事件被拒。下载 started 为 unknown，仅对应下载 done 事件能写 completed/cancelled；中断后未知保持未知。

墙钟 30 分钟含暂停；超过时不继续原 session。条数、事件字节、图字节、总字节在入口检查，超限标为 budget-exceeded；保留控制/终结需要的少量空间。不保留原始页面输入对象。暂停之后 DOM preload 立即禁用，恢复先在宿主验证新源并重新配置。

## 行为和发布条件

按 spec 的 R01–R07 覆盖 schema 摘要/权限语义、source 隐私、store revision/恢复/预算、主框架 IPC 验证、下载迟到关联、UI 暂停/删步/导出和桌面实际窗口。证据区分合成 fixture、组件模拟、真实 Electron GUI 与重启恢复。F03 真实模型转换不属于 F02，不将 fixture 宣称全链路完成。

## S1 契约修订（协调评审）

初稿只保留摘要与几何图会丢失示教语义。根据协调任务评审，在 schema v1 首次实现前补充 routeTemplate、role、accessibleName 和受控局部截图。敏感 query 值保留运行时参数位置；普通业务语义可保留，捕获不安全的截图明确不可用。共享来源身份策略已获协调确认。

## 复用与自研边界（用户新增约束）

本轮通用可访问名称/角色算法改用固定版本 `dom-accessibility-api@0.7.1`（MIT），复用 `computeAccessibleName`、`getRole`，删除手写名称与角色映射主体。该库实现标准可访问名称算法，仓库维护 changelog 与标准测试；本轮在 pnpm registry 核对版本/许可，锁定 lockfile，打包进隔离 preload，不从 CDN 加载。其 DOM 计算结果仍经本地敏感过滤和字节预算，库不承担 CrewON 授权策略。密码等已识别敏感控件在调用库之前排除。实际 Electron 隔离上下文与 CSP 合成页面验证记入 evidence。

评估 rrweb（MIT）事件采集和 maskAllInputs/blockSelector：它以 DOM snapshot/replay 为主要数据面，首发无需重建整站；完整 DOM、属性和增量序列会扩大捕获范围，并仍需页面特定的敏感过滤。此次不引入完整 rrweb recorder；采用成熟语义模块 + Electron 原生导航、下载事件与 capturePage 局部图能力，实现有限的标准 HTML click/change 语义适配。不会继续扩展自研可访问性算法、DOM 重放、浏览器协议或新 runtime。aria-query 是角色元数据候选，dom-accessibility-api 已封装本轮所需语义，无须再次手工拼装角色解析。

复用仓库 canonicalJsonValue、ContractValidationError、React、Electron/esbuild/vitest 构建测试、桌面桥与当前设计主题。必要自有代码仅为 C01 业务形状、输入和目标过滤、授权/会话隔离、预算、revision、持久化、下载关联与UI控制。执行定位交由 F05 的成熟浏览器执行能力评审，不从录制 selector 推演新执行引擎。

参考：[dom-accessibility-api 官方仓库](https://github.com/eps1lon/dom-accessibility-api)、[rrweb 隐私配置](https://github.com/rrweb-io/rrweb/blob/main/docs/recipes/privacy.md)。开源语义支持不代表任意网站、跨源框架或任意敏感内容均已验证。

## 接口收敛与实测修订

录制控制 IPC 以 recordingId 绑定当前录制，pause/resume/finish 在宿主串行处理当前状态；expectedRevision 用于兼容传输而不让持续到达的新事件阻断暂停。删步/说明修改仍严格 expectedRevision，错录制 ID 一律拒绝。远程 preload 回报对应 generation 的 armed ACK 后才标为可采集；重复导航就绪通知复用同 generation，导航使已接受动作只丢弃过期画面，不丢失先前动作语义。暂停/结束/关闭以独立 control epoch 拒收迟到采集。

F03 交接端口是主窗口 desktop.recording.onSkillImportRequest(listener)：教学页显式“生成 Skill 草稿”后，宿主校验当前快照与有界证据并只向确切 ownerWindow 发送 requestId、recording、evidence{evidenceId,mediaType,dataBase64}。消费者注册前按钮禁用；消费者通过现有认证客户端导入并返回真实结果。预备阶段串行锁、requestId 匹配、60 秒超时、主框架导航撤销用于防止串任务/重复响应；超时保持结果未确认提示，不声称导入成功。该调用不授予执行权限。

F05 的 main-only `RecordingExecutionAccess` 与 `RecordingExecutionLease` 在独立模块中。录制 recording/paused/interrupted 阻止 acquire；结束后可供 F05 按已授权任务获取同一个 WebContentsView，租约包含 AbortSignal。录制开始/控制、用户导航和窗口关闭同步 revoke；generation 变化只失效当前租约，F05 决定任务 grant 的保留。即使没有租约，subscribeExecutionRevoked 仍收到用户接管事件，避免旧 grant 复用。Cookie 由 Electron 的 persist:crewon-teaching 分区自行保存，与录制数据分离，录制器不读取/复制 Cookie。人工输入与 Puppeteer 输入的区分和当前任务授权控件由 F05 负责并验收，F02 不宣称已验证该识别。

## 实现期故障闭环

截图候选保存在隔离 preload 的有界私有表中。宿主截图前后分别复核同 generation、目标与同步 DOM mutation 版本；变化、超时、错误 sender 或无法确认时不编码/持久化 PNG。同 selector 的旧候选不能由后续点击更新借用。下载导致的临时导航会关闭源，但下载关联仍按确切 view 与正在录制的 session 记录；did-stop-loading 为仍存活的页面重新握手。
