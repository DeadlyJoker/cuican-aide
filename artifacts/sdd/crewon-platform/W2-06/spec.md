# W2-06 Specification: CrewON UI Provider / Resource 接入

状态：P0-P4 Green，已通过独立组件 Gate。W2-04 已提供 authenticated Workspace、Provider connection、Resource catalog 与 durable bind/unbind experimental RPC；本任务已建设 first-party UI client、恢复状态机和独立组件，未提前接入 `App.tsx`，不执行资源。

## 1. 用户结果

- 用户看到的 Provider、Agent、Skill、MCP、Knowledge 与 Binding 状态必须来自当前 app-server 连接，不能来自浏览器直连 Agent Platform、演示数据或 localStorage 缓存。
- Skill、MCP、Knowledge 在 Composer 中只显示一个独立标签；文件、文件夹沿用输入附件标签；图片仍只通过现有粘贴能力进入，不新增图片入口。
- 断线或 app-server 进程重启后，页面保留的非敏感选择可以通过新的 principal session、Workspace bind、Provider connect 和 exact Resource re-bind 自动恢复。浏览器刷新后不伪造恢复；服务端缺少 owner-scoped binding list/read 时显示真实未绑定状态。
- Web 与 PC 共用同一资源选择组件。文件/文件夹能力由既有 Composer capability 提供，本任务不伪造浏览器绝对路径。

## 2. 权威与边界

- UI 只发送公开选择：固定 first-party `providerId=agent-platform`、服务端返回的 `workspaceKey`、调用方提供的 scope/scopeId、服务端返回的 connectionId/workspaceBindingId、exact `ResourceRef` 与用户选择的 binding mode。
- actor、tenant、space、CredentialRef、endpoint、token、签名材料、Workspace root path、execution location 均由服务端解析，禁止进入请求、组件状态、日志或 localStorage。
- UI 不直接调用 Agent Platform Tool/Knowledge/Agent 执行 API；Resource Binding 只产生后续 Task/Tool Router 可消费的引用，不代表执行成功。
- App-server experimental capability 是显式 first-party opt-in；稳定 `ClientRequest` schema 继续过滤实验方法。UI 使用单独生成的 experimental TypeScript overlay，不能手写 wire DTO，也不能把实验方法混入稳定 index。

## 3. 状态机

`idle -> connectingProvider -> listingResources -> ready`。

- `ready -> binding -> bound`：先用当前 session 的 Workspace binding，再 exact bind Resource。
- `bound -> unbinding -> ready`：成功 unbind 后只保留 Resource catalog selection，不保留 active binding。
- 任一远端调用遇到 unauthorized、revoked、authority changed 或 unavailable：进入 `unavailable`，清除 connection/workspace binding/binding projection，保留 bounded、非敏感的 exact Resource selection 供当前页面重试。
- WebSocket 重连：递增 recovery generation；旧 generation 的迟到 response 不得覆盖新状态。按 Workspace list/bind -> Provider connect -> Resource list -> 当前选择 exact read/bind 顺序恢复。
- pagination：每页和总项数都有硬上限；重复 cursor、超过页数、缺失 exact Resource 均 fail-closed，并从首游标做一次 bounded re-read。第二次仍异常则显示不可用，不无限重试。
- `resource/binding/updated` 只接受当前 connection、workspace 和已知 bindingId；revision 必须单调递增。未知、旧 revision 或跨上下文 notification 被忽略并触发 bounded reconcile，而不是直接成为权威。

## 4. TypeScript 协议生成

- 新增独立 vendored `schema/typescript-experimental-platform/`，只导出 W1/W2 first-party platform experimental request/response/notification 及其递归依赖。
- 稳定 `schema/typescript/`、JSON schema 和 `ClientRequest` 联合类型保持现有过滤语义。
- overlay 必须由 Rust `ts-rs` 生成、带 generated header/index，并通过相对导入完整性 Harness；UI 使用独立 alias 导入。
- 不提交完整 869 文件 experimental schema 副本，不复制稳定 schema，也不在 UI 手写 Params/Response。

## 5. UI 组件契约

- `ProviderResourceClient`：窄 RPC transport，只暴露 workspace list/bind、provider connect/read、resource list/read/bind/unbind。
- `ProviderResourceController`：拥有 pagination、generation、reconnect/reconcile、状态投影与错误分类；不依赖 React、DOM 或 localStorage。
- `ProviderResourcePicker`：只渲染真实 projection；连接中、空、不可用、已撤销、能力不支持均有明确状态。
- `ComposerResourceTags` 继续承载 file/folder/image/knowledge/mcp/skill 视觉标签；W2-06 增加从 `ResourceRef + BindingProjection` 到标签的纯映射与 snapshot，不改变图片语义。
- W2-08 才把 controller/组件接入 `App.tsx`、主页 Composer、Office/Workflow/Experts scope。

## 6. 安全停止条件

- 若 app-server 未配置 Provider、principal session 不可用、Workspace 无法绑定或 Resource capability 不支持，UI 显示真实不可用，不回退到旧 `/agent-platform-api` 或 fake success。
- 若无法从生成协议获得 DTO，先修生成链，禁止手写临时 wire type。
- 若需要浏览器刷新后恢复 active bindings，先新增 owner-scoped binding list/read API；本任务不使用 localStorage 猜测服务端权威。
- 若接线需要修改 `App.tsx` 或删除旧直连路径，暂停在独立组件 Gate，交给 W2-08 做原子切换。
