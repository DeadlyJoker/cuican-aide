# F05 详细设计 / C05

## 源码事实与路线

- `apps/crewon-ui/electron/browserViews.ts` 只创建/导航/展示/销毁 WebContentsView，无执行 API。
- `apps/runtime-worker/src/runtime-process-environment.ts` 的 createConfiguredToolRuntime 被 release-main 与 main 共用，CompositeToolRuntime 可组合独立工具。
- `packages/device-dispatch` 已有签名设备命令和 gateway，当前 Electron 未部署其 mTLS peer；强行用它会扩展设备注册生命周期。首版复用 ToolRuntimePort，添加仅本机认证 HTTP 宿主适配，不修改 device 协议。
- RuntimeSupervisor 已以私有环境向 release/worker 传递配置；本机桥随机凭据由 main 创建并传递，不暴露到 remote 页或模型。
- F02 owns BrowserViewManager/main 录制部分。F05 新增独立 browserExecution\* 模块，最小端口协商由 F02 实现，同一 view/partition 结束录制后切换执行。

## C05 v1

注册 function `crewon_browser_observe` 与 `crewon_browser_act`。observe 为 readOnly/replaySafe；act 为 mutation/reconcilable、perAction。所有执行限时 30 秒，工具输出 ≤9KiB UTF8，下载 ≤20MiB。缺省 sessionId 由已授权 thread 的唯一浏览器解析，用户不手填身份。

observe 输入 `{sessionId?: string}`。返回 `{schemaVersion,sessionId,generation,observationId,url,targets,truncated,unsupported}`；URL 不含 query/hash/userinfo，target 包含 opaque targetId、role/name 和控件类型，禁止回传密码/输入值/页面全文。

act 输入 `{sessionId,generation,observationId,action,target?,url?,value?}`。action 为 navigate/click/fill/select/download；target 为 `{targetId}` 或 `{role,name}`，必须在当前观察唯一命中。navigate 只允许 http(s) 且无 userinfo。未知字段/未知动作拒绝；没有 evaluate/css/path 能力。

认证桥 transport 封装 operation execute/reconcile/cancel、宿主绑定、真实 runId、executionId、actionDigest、ToolRuntime 核验后的命令；输入中的 run/thread/session 声明均不能替代权限。仅绑定 127.0.0.1，随机 bearer、不接受跨站 Origin、不公开 CORS，HTTP body 上限。工具层校验 action intent、policy、lease、approval，宿主每次以现有 Control 会话查真实 Run、thread 与运行状态，匹配可信桌面授权。

## 授权、窗口和状态

可信 UI 明确选择“允许当前任务使用该页”，经 main renderer IPC 校验后建立 thread→session 授权；Control 校验 thread/Run。授权不由 C01 导入触发。F02 最小宿主端口提供 session 身份、WebContents、generation、acquire/release/revoke。paused recording 也不允许执行，必须结束采集。WebContents 永不跨 renderer/worker 返回。

每次执行先核验授权、活跃 Run、session/mode、generation，再在同一个页面隔离世界内核对观察目标身份和敏感性后动作。导航开始/同文档位置变化使 generation 递增并清除观察。录制开始、人工输入、关闭或显式接管 revoke；取消/撤权中止下载与正在等待的动作，后续请求 fail closed。

## 恢复、存储与兼容

宿主在私有数据目录按 executionId 持久写 dispatching 记录（含输入摘要、run/session 身份）；先写成功才动作。完成后原子写终态与有界结果。相同身份返回原结果；同 executionId 不同摘要拒绝。启动读到 dispatching 转 unknown，不重放。网络断连/超时后 reconcile 只查状态。容量满拒绝新动作，不能驱逐 idempotency fence。

下载挂接同一 WebContents 的 session will-download，确认事件来源和本请求；宿主生成文件名，限时/限大小，done=completed 后读真实字节并摘要。F01 提供可信字节导入端口，返回权威文件引用；失败不能声称文件已进入交付。F01 未就绪时明确依赖，不能输出伪造引用。

新增 C05 独立契约，不修改 DeviceProtocol、C01/C02/C03 形状。共享 entrypoint/main/runtime 注册只做必要接线，集成按语义合并。

## 测试与交付条件

B01/B02：真实工具配置与认证桥网络测试、跨 thread/撤权反例；B03/B04：标准业务页、导航旧目标/歧义/敏感控件/大页面；B05：录制互斥、排队取消、下载取消；B06：重复请求/断连/进程重建；B07：真实 Electron 下载+F01 导入；B08：旧 catalog、边界检查与类型检查。

证据分别记录端口模拟、真实 Electron GUI、真实模型 Run、流式重连、跨进程恢复。通过单测不表示通过 E04；没有真实授权/部署接线必须报告缺口。
