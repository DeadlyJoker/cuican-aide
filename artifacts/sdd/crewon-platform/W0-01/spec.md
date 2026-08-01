# W0-01 Canonical Platform Contract 规格

状态：完成  
上位任务：<code>artifacts/crewon-platform-wave-sdd-execution-guide.md</code> W0-01

## 当前事实

- app-server v2 已有 Agent Platform、CrewON Domain、Office、Automation 等接口，但大量旧 Params 仍直接携带 accessToken、cwd、JSON config。
- 直接重命名或删除这些接口会破坏 PC/Web 调用和现有恢复链路。
- schema/TypeScript 由 <code>crewon-app-server-protocol</code> 统一生成，并有 vendored fixture 对比。
- 当前没有独立、版本化的平台引用契约，后续 Identity、Workspace、Credential、Provider、Resource、Task、Approval、Artifact 和协作消费者容易各自发明同义字段。

## 本切片目标

新增不带 RPC 的 v2 canonical platform contract：

- 服务端身份引用。
- Workspace 引用，不暴露 root path。
- Credential 引用，不暴露 Secret/owner。
- Provider 与 Capability。
- Resource 与 Binding/ExecutionLocation。
- Task/Authority/Strategy/Status/Event/Cursor。
- Approval/ActionDigest。
- Artifact/Retention。
- Team 与 Automation 引用。
- 平台错误分类。

契约以 Rust 类型为单一来源，同时生成 TypeScript 和 JSON Schema，并用一个版本化 JSON 示例做完整对象 round-trip。

## 安全不变量

1. canonical contract 不定义任何 <code>*Params</code>，不新增未实现 RPC。
2. ClientRequest Params 中不得出现 actorId、tenantId、spaceId、credentialOwner、workspaceRoot、最终 authority 或 strategy。
3. Workspace 只暴露 workspaceKey/bindingId/scope/node/environment 引用，不暴露 canonical root。
4. Credential 只暴露 credentialId/providerId/status/expiry，不暴露 Secret。
5. 所有 API 边界 ID 使用 String；时间使用 i64 Unix seconds 且以 At 结尾。
6. enum 采用 camelCase，未知关键 enum 由反序列化 fail-closed。
7. 一个 Task 只携带一个 Authority；运行中 Authority 切换不属于本契约。

## 兼容策略

- 旧 AgentPlatform 和 CrewON Domain 接口本切片只冻结，不修改、不接入新类型。
- 新类型没有 RPC，所以不会改变现有客户端行为。
- schema generator 只生成已注册 Rust 类型；历史提交中存在没有对应 Rust 类型、没有进入 ClientRequest/dispatcher 的 Office standalone schema。它们不是可调用 API，本切片不把这些孤儿 schema 误注册成新 RPC。
- 后续 W1/W2 只能引用该契约；真正切换和旧接口删除由 integration/cutover 任务负责。

## 非目标

- 不实现 Identity、Workspace Registry、Credential Store、Task Runtime、Provider HTTP 或 UI。
- 不创建空服务、空数据库或 Facade。
- 不向 v1 增加接口。

## 验收

- canonical JSON 示例可以反序列化并完整等值序列化。
- 未知/多余 fixture 字段会因完整 JSON equality 被检测。
- ClientRequest property 安全断言通过。
- TypeScript/JSON Schema 由现有 schema generator 生成。
- <code>just write-app-server-schema</code> 和 <code>just test -p crewon-app-server-protocol</code> 通过。
