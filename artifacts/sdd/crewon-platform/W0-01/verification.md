# W0-01 验证记录

状态：完成

## Discovery 证据

- 旧 <code>AgentPlatformAuthParams</code>、<code>AgentPlatformChatParams</code> 等包含 accessToken/threadId/agentId。
- CrewON Domain Params 广泛使用 cwd 和 JSON config，当前不能无迁移直接替换。
- app-server schema 由 <code>generate_ts_with_options</code>、<code>generate_json_with_experimental</code> 和 vendored fixture test 管理。
- 新 canonical contract 可以作为无 RPC 的生成根类型，不必创建假接口。

## Harness Red

先引入测试模块和 canonical fixture 读取逻辑，但不提供 <code>PlatformContract</code> 类型。

命令：

<code>just test -p crewon-app-server-protocol platform_contract</code>

结果：编译失败，报告 canonical contract 类型不存在。该失败发生在生产类型实现之前，证明 Harness 不是实现后的自证测试。

## Harness Green

实现 Rust canonical DTO/enums、TypeScript/JSON Schema 导出和版本化 fixture 后：

- <code>just test -p crewon-app-server-protocol platform_contract</code>：2 passed。
- <code>just write-app-server-schema</code>：通过，生成 PlatformContract JSON Schema 和对应 v2 TypeScript 类型。
- <code>just test -p crewon-app-server-protocol</code>：234 passed，0 skipped。

Harness 覆盖：

- canonical fixture 完整反序列化、序列化等值和对象等值；缺字段、多字段、rename、错误 enum tag 都会使解析或完整 JSON equality 失败。
- ClientRequest schema 递归扫描，禁止客户端 Params 暴露 actorId、tenantId、spaceId、credentialOwner、workspaceRoot、authority 和 strategy。
- vendored JSON/TypeScript schema 与 generator 输出完全一致。

协议包全量测试首次运行时发现既有 <code>scene_descriptor_is_derived_from_runtime_registry</code> 断言仍期待 Conversation/ReadOnly，而真实 registry 和同模块运行时测试均为 Document/WorkspaceWrite。仅校正了这条陈旧测试期望，没有改变场景注册或运行行为；重跑后 234/234 通过。

## Breaking-change 审核

- app-server API：未新增 ClientRequest、ServerRequest、通知或 RPC；现有方法、请求和响应不变。
- CLI 参数、配置加载、rollout/session 恢复：无变化。
- canonical 类型是新增的无 RPC v2 导出根，不会接管旧调用链。
- schema generator 清理了历史提交中没有 Rust 类型、没有 ClientRequest 变体、也没有 dispatcher 注册的 Office standalone schema。仓库内 UI/processor 对这些方法的引用属于既存未闭合实现，不能以生成文件冒充可调用 API；本切片没有激活它们，后续 Office cutover 必须单独修复或删除。
- 非机械实现集中在独立 <code>platform_contract</code> 模块和测试文件；大体积变化主要是 generator 产出的 schema/TypeScript，未扩张高触达 processor 或 crewon-core。

## 未验证

- 按仓库规则，协议/公共 Rust 变更后的 workspace 完整 <code>just test</code> 需要用户明确允许，本切片只运行了受影响 crate 的 234 项完整测试。
- 本切片不验证或修复历史 Office manager/automation binding 未注册 RPC；它们不属于 canonical contract 的实现范围。
