# W1-02 Workspace Registry 与 Binding 规格

状态：已完成  
上位任务：<code>artifacts/crewon-platform-wave-sdd-execution-guide.md</code> W1-02  
前置：W1-01 Server-derived Request Identity

## 当前真实入口

- CrewON UI 通过 URL <code>cwd</code>/<code>teamCwd</code> 保存 Single 与 Office 工作目录；两者虽然已分开，但值仍是客户端可修改的绝对路径。
- Thread/Turn 的 <code>cwd</code>、<code>runtimeWorkspaceRoots</code>，Office/Agent/Knowledge API 的 <code>cwd</code> 都直接接收客户端路径。
- app-server 启动配置已经拥有可信的 <code>Config.cwd</code>、<code>effective_workspace_roots()</code>、installation id 和本地 environment id，但没有统一 Workspace Registry。
- W1-01 当前只能提供 connection-scoped actor/session；没有可证明为同一用户的持久 subject，因此不能把 Workspace key 跨连接恢复给“同一用户”。

## 本切片目标

- 在 <code>app-server/platform_control</code> 下建立 session-scoped Workspace Registry。
- 服务端把启动时已配置的 root catalog canonicalize 后映射为 opaque <code>workspaceKey</code>；客户端不能提交或读取最终 root path。
- 同一个 <code>workspaceKey</code> 可以建立多个 scope binding；Conversation/Single 与 Office 即使指向相同 canonical root，也必须拥有不同 <code>bindingId</code> 和 scope。
- Registry 内部统一执行安全路径解析：拒绝绝对路径、<code>..</code>、symlink escape、已删除或不可访问 root。W1-10 在出现真实消费者时只能增加 binding-aware adapter，不得导出 key-only resolver。
- 新增 experimental v2 <code>workspace/list</code> 与 <code>workspace/bind</code>，只验证新基座，不切换既有 Thread/Office/Knowledge Authority；统一接线仍由 W1-10/W3 完成。

## 生命周期与 Authority

| 数据 | 权威来源 | 生命周期 |
|---|---|---|
| canonical root | server startup <code>Config.cwd</code> + effective workspace roots | app-server process catalog |
| workspaceKey | server UUID，按 canonical root 在当前 connection session 内生成 | connection session；不持久化 |
| bindingId | server UUID，按 workspaceKey + scope + scopeId 生成 | connection session；重复 bind 幂等 |
| nodeId | server installation id | app-server installation |
| environmentId | server local environment id | 当前 local adapter |
| scope/scopeId | client 选择的领域关联 | 只作 binding identity，不授予额外文件权限 |
| root path | 仅 Registry 内部持有 | 永不进入 API、UI、rollout 或模型上下文 |

连接关闭或 app-server 重启后，旧 <code>workspaceKey</code>/<code>bindingId</code> 必须失效。未来只有在 transport 提供可信、可持久的 subject/tenant/space 后，才能通过独立 SDD 引入 durable registry；本切片不猜测用户身份。

## API

### workspace/list

- experimental v2 cursor list，Params 仅包含 <code>cursor</code>/<code>limit</code>。
- 返回当前 session 可见的 server-registered roots：<code>workspaceKey</code>、display name、node/environment、availability。
- 不返回绝对路径、相对路径、OS 用户信息或 permission snapshot。
- <code>accessMode</code> 使用枚举区分 <code>localProcessServerRoots</code> 与 <code>remoteServerRoots</code>；两者当前都只能使用 server-registered roots，不能直接添加路径。

### workspace/bind

- Params：<code>workspaceKey</code>、<code>scope</code>、<code>scopeId</code>。
- 返回 canonical <code>WorkspaceRef</code>。
- 同一 session 对相同 workspaceKey/scope/scopeId 重复 bind 返回同一对象；不同 scope 或 scopeId 返回不同 bindingId。
- 未在当前 session 注册的 key 统一返回“not registered for this session”，不暴露它是否属于其他 session。

## 路径安全不变量

1. root catalog 只接受服务端配置的绝对路径；先 canonicalize、确认是目录并检查可访问性，再生成 workspaceKey。
2. canonical aliases/symlink roots 指向同一目录时只生成一个 workspaceKey。
3. 内部相对路径解析拒绝 absolute/root/prefix/parent components。
4. join 后再次 canonicalize 并检查 <code>starts_with(canonical_root)</code>；嵌套 symlink 指向 root 外必须拒绝。
5. 已登记 root 后被删除，状态为 missing；权限不足或 I/O 拒绝时为 unreadable；两者均不能 bind/resolve。
6. key、binding 和 catalog 都有硬上限；分页 limit 有硬上限，不能形成无界 session 状态。
7. workspace binding 不等于执行授权；后续文件、Tool、Provider 操作仍需 W1-08 Policy 和 W1-10 composition。
8. 本切片不向其他模块暴露 workspaceKey 到路径的解析 API；未来消费者必须同时验证服务端 binding scope，不能把 workspaceKey 当执行 Authority。

## Web 与本地语义

- Stdio/InProcess 返回 <code>localProcessServerRoots</code>。
- WebSocket/RemoteControl 返回 <code>remoteServerRoots</code>。
- 两种模式都只能选择服务端已经注册的 opaque key；本切片不实现 Tauri picker grant、Cloud Workspace Registry 或客户端路径注册。
- capability 差异由枚举表达，不使用 bool/None 猜测。

## 非目标与迁移边界

- 不修改现有 <code>cwd</code>/<code>teamCwd</code> UI 和旧 app-server API；它们保持现状但不得成为新模块的 fallback。
- 不新建文件系统沙箱、数据库、登录系统或跨设备 Workspace 服务。
- 不把 Workspace 领域模型放入 <code>crewon-core</code>。
- 不把 Registry 写入 Office JSON、Thread rollout、localStorage 或 URL。
- 不在 W1-02 将 Single/Office/Knowledge 请求改写为 workspaceKey；消费者切换必须在对应 Wave 原子完成。

## 验收

- Harness Red 证明 workspace DTO/RPC/Registry 在实现前不存在。
- unit Harness 覆盖 canonical root、合法子路径、absolute/parent/symlink escape、missing root、幂等 bind、scope 隔离和跨 session key 拒绝。
- TestAppServer 覆盖 list/bind、客户端 path 字段注入拒绝、Single/Office binding 隔离和重启后旧 key 失效。
- schema、protocol 和 app-server targeted tests 通过；breaking review 证明没有切换旧 Authority。
