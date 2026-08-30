# W1-01 验证记录

状态：完成；W1-01 targeted gate 通过，workspace 完整测试仍等待用户授权

## Discovery 证据

- ConnectionId/ConnectionOrigin 由 app-server-transport 创建，客户端 JSON 不能设置。
- 实施前 app-server ConnectionState 会忽略 origin，ConnectionSessionState 只存 initialize 后的客户端声明信息；本切片已将可信 origin 接入连接身份基座。
- WebSocket auth 成功结果未向 ConnectionOpened 传递 subject claims；现有 JwtClaims 也没有 sub/tenant/space。
- 因此当前只能建立 connection-scoped actor；tenant/space 必须 fail-closed 为 null。

## Harness Red

- 在 protocol/runtime 类型存在前执行 <code>just test -p crewon-app-server request_identity</code>。
- 编译按预期失败：<code>IdentityReadResponse</code> 与 <code>RequestIdentityTransport</code> 尚不存在，证明测试不是在既有实现上直接变绿。
- trace 校验收紧时，直接从生产代码引用仅存在于 dev-dependencies 的 <code>opentelemetry</code> 也被编译 Harness 拒绝；该方案已撤回，没有扩大 Cargo/Bazel 依赖面。

## Harness Green

- <code>identity/read</code> 集成 Harness：4/4 通过，覆盖同连接稳定、跨连接隔离、四 transport 分类、重连重新派生、伪造 authority Params 被拒绝且不改变身份。
- trace Harness：1/1 通过，覆盖合法 W3C trace 关联与无效 trace 的 server-generated 32 hex fallback。
- stable schema 已由 <code>just write-app-server-schema</code> 更新；experimental schema 在临时目录生成成功并清理。
- <code>just test -p crewon-app-server-protocol</code>：236/236 通过，schema fixtures 同步。
- 最终 <code>just test -p crewon-app-server</code>：997/997 通过，1 个既有 skip。两个既有 Office auto-dispatch/recovery 用例首轮波动、nextest 第二轮通过；上一轮完整 app-server 测试为 996/996 直接通过。本切片没有修改这些 Office 路径，也没有隐藏重试事实。
- <code>just fix -p crewon-app-server-protocol</code> 与 <code>just fix -p crewon-app-server</code> 完成；本切片引入的参数过多告警已通过内部 <code>InitializedRequestContext</code> 消除。app-server 仍报告 5 个来自现有 Agent Platform/Office 改动的告警，本切片未用 allow 掩盖。
- 最后执行 <code>just fmt</code>；随后 <code>git diff --check</code> 通过。

## Breaking-change 审核

- 仅新增 experimental app-server v2 <code>identity/read</code>；没有修改 v1、现有 request/response shape 或方法语义。
- stable schema 不暴露该 experimental 方法；新增共享 DTO/TS export 为 additive change。
- <code>ConnectionSessionState::new</code> 是 crate 内部 API；app-server 完整 crate 测试覆盖 Stdio、InProcess、WebSocket 与既有连接生命周期。
- CLI 参数、config、rollout/session 恢复、Core model context、数据库和 UI persistence 均未变化。
- 没有新增 Cargo 依赖、Cargo.lock 或 Bazel lock 变化；依赖方向保持 protocol -> app-server platform_control -> composition，不反向依赖业务 Processor。
- RequestIdentity 只驻留于连接/session 与单次请求内；tenant/space 在可信 claims 接入前保持 null，clientInfo/capabilities 和上游 trace 均不参与授权。
- W1-01 新模块均远低于 500 LoC；中心文件只做 origin/identity 的最小接线，W1-10 前不穿透业务域。

## 未验证

- 公共协议变更后的 workspace 完整 just test 仍需用户明确授权。

## 结论

W1-01 验收成立，可以作为 W1-02 Workspace Registry、W1-07 Context 和 W1-08 Policy 的服务端身份前置。后续业务 Processor 的统一 composition 仍由 W1-10 完成，不能提前读取客户端同名 authority 字段。
