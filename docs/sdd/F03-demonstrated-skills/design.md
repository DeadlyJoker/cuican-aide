# F03 设计与 C02

## 源码事实

- `packages/capability-packs/README.md` 是会议模板试点，无示教宿主。
- `packages/application/src/turn-application-service.ts` 的 startTurn 原子提交消息、Run、outbox 与 workItem；重试有 replayTurn。
- `packages/agent-version/src/agent-version.ts` 已有不可变 AgentVersion；F03 不另编执行引擎、不改变它的身份。
- `apps/control-api/src/control-api.ts` 的 turns 路由已有身份、routeResolver、默认 requestApproval；新路由复用这些依赖。
- `packages/store/src/sqlite-run-store.ts` 是本地持久化运行权威。新增独立 Skill store 模块，避免扩大此高频文件。
- `apps/crewon-ui/src/lib/skill/skillDetailActions.ts` 只读取文件/插件 Skill；新示教面板应显式使用宿主生命周期。

## C02 最小契约（F03 owner，候选 v1）

权威类型位于 `packages/domain/src/demonstrated-skill.ts`，应用端口在 `packages/application/src/skill-invocation-port.ts`，从 package entrypoint 导出。F04 仅依赖端口。

```ts
type SkillVersionRef = Readonly<{
  skillId: string;
  versionId: string;
  contentDigest: string; // sha256:<64 lowercase hex>
}>;
type SkillInvocationSpec = Readonly<{
  schemaVersion: "crewon.skill-invocation.v1";
  skill: SkillVersionRef;
  parameters: Readonly<Record<string, string | number | boolean>>;
  requiredToolRefs: readonly string[];
  // deliveryTarget?: DeliveryTargetRef; 精确结构由 F01 C03 冻结后引入
}>;
interface SkillInvocationPort {
  resolveVersion(actor: ActorContext, ref: SkillVersionRef): Promise<SkillVersion>;
  admitInvocation(actor: ActorContext, spec: SkillInvocationSpec,
    options: { purpose: "schedule" | "execute" | "trial" }): Promise<SkillAdmission>;
}
```

SkillAdmission 返回已规范校验的 invocation、不可变 version 和 bounded `context`。调用准入不是持久授权凭据：F04 保存时用 schedule；每次真正触发再次用 execute，仍需现有 Run/ToolRuntime 的授权。trial 仅 owner 可调用待试跑版本，execute/schedule 要求该版本已激活且 Skill 未禁用/删除。requiredToolRefs 必须与版本声明一致，不能由调用方增减权限。scope 来自 actor，不接收客户端 tenant/owner。

输入 schema 是严格扁平字段列表（name、label、type string/number/boolean、required、可选 string enum）；最多 24 个字段，每字符串最多 2048 bytes，参数总计 4096 bytes，禁止未知字段、非有限数字、原型键。敏感依赖仅声明运行时授权引用，参数 schema 不支持 secret 类型；录制敏感值不进入正文。版本身份不可为 latest。方法 Markdown 上限 8192 bytes，完整执行上下文上限 16384 bytes，以 UTF-8 字节作为保守 token 上界还需压至 9216 bytes，超过则拒绝（不截断方法）。

## 宿主状态、持久化与恢复

SkillRecord 保存 skillId、tenantId、spaceId、ownerActorId、revision、draft、disabled/deleted 状态。草稿每次修正执行 CAS。seal 从当前 revision 生成 SkillVersion（ref、结构化方法、schema、SKILL.md、录制 provenance）；版本 append-only。激活状态与试跑证据单独保存，不能更改被引用的内容摘要。每次修改必须重新 seal/试跑；已激活旧版本仍可显式调用，禁用影响全部新执行。

SkillInvocationRecord 固定 spec、threadId、runId、用途和幂等键。先持久化准备记录，再调用现有 turns 并绑定实际 Run；若进程在 Turn 提交后崩溃，使用相同 command/idempotencyKey replay 找回 Run。并发重复不得创建新 Run；未知结果保持 pending/recoverable。Run 状态从现有权威读出，不接受客户端提交 succeeded。激活核验保存 runId、版本摘要、逐项标准/覆盖与用户确认；服务端核对 Run completed 且为本版本本 actor 的 trial。模拟执行证据有显式 provenance，不能用于真实激活。

首版持久化独立 SQLite 表/连接（复用本地数据库路径），事务 CAS、唯一版本/调用键和有界分页；重启/双连接测试。Postgres 部署未接入时端口缺省不可用，拒绝路由，不降级内存假成功。历史不受版本编辑或禁用破坏。

## HTTP / UI / 授权

新增 `/api/v1/skills` 命名空间：列表、导入录制生成草稿、读取/修正、seal、版本读取/SKILL.md、trial/invoke、trial 核验、activate、disable。所有写入有 revision 或 idempotencyKey。现有 turns/run/event shapes 不变，Skill 关联由宿主记录保存。新路由缺宿主返回明确不可用，不改变旧 Skill 文件读取行为。

新增独立 DemonstratedSkill 面板放既有资源库 Skill 区域，使用现有 library 样式与 React 状态。展示结构化编辑、变量表单、不可变版本/试跑真实状态与激活条件。开始试跑进入现有任务，以现有 streaming、恢复和审批承载执行。入口与 F02 导出引用接线，组件可用显式 contract fixture 验证；不得把 fixture 当正式 Skill。

所有权限来自已验证 ActorContext 及宿主 owner/scope。复用现有 AuthorizationPort 对 Run/Thread/工具的检查，新增 Skill 权限由独立策略端口 fail closed，避免擅扩其他 feature owner 模块。未授权工具或交付目标直接拒绝；正文中的说明不授予权限。敏感值由既有工具交互运行时提供，不存日程参数。

## 兼容、自检与依赖

新增 C02 与独立表，旧 prompt Automation、AgentVersion、Run 事件不改形状。F04 自己负责 Automation discriminated binding。C01 由 F02 校验并投影；未知 schema/digest/scope 拒绝，原始录制不复制到版本，按需读取有界证据。F01 DeliveryTargetRef 尚待 owner，暂不自行定义路径协议。F03 不修改 recorder/scheduler。

发布条件：需求与测试对应；真实 F02、F01、模型/浏览器工具接线；新参数/异常成功交付；流式、刷新、重启、禁用/撤权验证。没有这些只标为“可集成实现，真实闭环待验收”。
