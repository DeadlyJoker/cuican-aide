# W1-02 验证记录

状态：完成；W1-02 targeted gate 通过，workspace 完整测试仍等待用户授权

## Discovery 证据

- UI 的 <code>cwd</code>/<code>teamCwd</code> 来自 URL/search params，属于客户端状态。
- Agent/Office/Knowledge 与 Thread/Turn 多个 v2 Params 仍直接接收绝对路径或 runtime roots。
- app-server 启动 <code>Config</code> 已包含 server-resolved cwd、effective workspace roots；installation id 与 local environment id 也由服务端产生。
- W1-01 没有可持久 user/tenant/space subject，因此 durable cross-session Workspace 授权当前无法成立，必须选择 session-scoped fail-closed 生命周期。

## Harness Red

- 在 workspace protocol/runtime 类型存在前执行 <code>just test -p crewon-app-server workspace_registry</code>。
- 编译按预期失败：<code>WorkspaceListParams</code> 不存在，证明 TestAppServer Harness 先于生产实现建立。

## Harness Green

- Registry unit Harness：3/3 通过，覆盖 canonical root、合法 child、absolute/parent escape、Unix symlink escape、missing root、跨 session identity/key、local/remote access mode、bind 幂等和 Conversation/Office binding 隔离。
- TestAppServer Harness：2/2 通过，覆盖 path-free list、Single/Office 同 root 不同 binding、<code>rootPath</code>/<code>relativePath</code> 注入被 schema 拒绝、app-server 重启后旧 key 不恢复。
- stable schema 由 <code>just write-app-server-schema</code> 更新；experimental schema 在临时目录生成成功并清理。
- <code>just test -p crewon-app-server-protocol</code>：236/236 通过，JSON/TypeScript schema fixtures 同步。
- 最终 <code>just test -p crewon-app-server</code>：1002/1002 通过，1 个既有 skip；本轮没有 flaky retry。
- <code>just fix -p crewon-app-server-protocol</code> 与 <code>just fix -p crewon-app-server</code> 完成；W1-02 未产生 Clippy 告警。app-server 仍报告 5 个来自现有 Agent Platform/Office 改动的告警，本切片未用 allow 掩盖。
- 最后执行 <code>just fmt</code>；随后 <code>git diff --check</code> 通过。

## Breaking-change 审核

- 仅新增 experimental v2 <code>workspace/list</code> 与 <code>workspace/bind</code>；没有修改 v1 或现有 request/response shape。
- stable schema 不暴露两个 experimental 方法；新增 Workspace DTO/TS export 为 additive change。
- 现有 Thread/Turn、Office/Agent/Knowledge 的 <code>cwd</code>/<code>runtimeWorkspaceRoots</code> Authority 未切换、未双写、也没有在新链失败后 fallback 到旧链。
- Registry root 只来自 server <code>Config.cwd</code>/<code>effective_workspace_roots()</code>；生成 API/TS 中没有 rootPath、relativePath、canonicalRoot 或 PathBuf 字段。
- key/binding 仅驻留于 <code>ConnectionSessionState</code>，连接关闭或重启即失效；没有数据库、rollout、Office JSON、URL、localStorage 或模型上下文写入。
- Single/Office 可共享 workspaceKey，但 bindingId/scope/scopeId 独立；workspaceKey 本身不作为执行 Authority，模块外没有 key-only path resolver。
- 没有新增 Cargo 依赖、Cargo.lock 或 Bazel lock 变化；没有向 <code>crewon-core</code> 增加 Workspace 领域代码。
- 变更按评审所有权拆成两个阶段：Registry core + protocol + unit Harness 为 697 行且复杂实现模块 404 行；v2 API/composition + TestAppServer Harness 为独立小阶段。各阶段均低于 800 行，复杂逻辑低于 500 行。

## 未验证

- 公共协议变更后的 workspace 完整 <code>just test</code> 仍需用户明确授权。

## 结论

W1-02 验收成立。W1-07 Typed Context 已具备 RequestIdentity + Workspace Binding 前置；Single/Office/Knowledge 的旧路径 Authority 仍需在对应 composition/cutover 任务中原子迁移，当前不能把新增 Registry 描述为生产切换完成。
