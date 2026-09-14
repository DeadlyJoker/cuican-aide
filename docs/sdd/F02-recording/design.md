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
