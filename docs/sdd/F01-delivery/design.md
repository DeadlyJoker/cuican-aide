# F01 设计与 C03 契约

状态：S1 自检完成；无上游依赖，待协调确认 C03。2026-09-14。

## 源码事实

- `packages/domain/src/artifact.ts` 仅允许 `kind: toolOutput` / `text/plain`，具有 run 到期时间。
- `packages/application/src/artifact-application-service.ts` 校验工具输出正文和来源；`packages/artifacts/src/artifact-retention.ts` 清理到期 blob。不能复用作用户文件存储。
- `apps/crewon-ui/src/lib/shared/composerAttachments.ts` 使用 XLSX 抽取前三张表并裁剪文本；原字节没有持久身份。
- `CommandWorkbenchFiles.tsx` 为文本/代码预览；`taskWorkbenchProjection.ts` 的普通回复不能作为文件存在证据。
- Control 由 `request-context.ts` / identity 解析 session，独立 route 模块接线可复用；standalone composition 已有授权与 thread 服务。
- Worker 的 `ToolRuntimePort` / `InMemoryToolBroker` 负责工具定义、effect 与恢复策略；不将文件引擎塞入 UI 或 Control。

## 最小跨 feature 契约 C03 v1

权威类型和严格解析器位于 `packages/domain/src/delivery.ts`，包根导出。

```ts
type DeliveryTargetRef = Readonly<{
  schemaVersion: "crewon.delivery-target.v1";
  tenantId: string;
  spaceId: string;
  threadId: string;
  targetId: "thread-deliveries";
}>;
type DeliveryResultRef = Readonly<{
  schemaVersion: "crewon.delivery-result.v1";
  target: DeliveryTargetRef;
  deliveryId: string;
  versionId: string;
  contentDigest: string; // sha256:<64 lowercase hex>
  mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  sourceRunId: string | null; // null explicitly denotes a user operation
  availability: "ready"; // emitted only after durable byte commit
}>;
```

目标是受既有 thread 权限保护的托管输出集合，threadId 是任务身份，不能以 cwd 字符串获得权限。F03/F04 保存此引用；使用时通过 F01 服务重新鉴权目标，不接受本机绝对路径、latest 或未知版本。历史结果固定 versionId/digest；来源 Run 由 Worker 上下文绑定，HTTP 人工操作固定 null。目标删除/任务撤权阻止新读写；暂不自动级联删除保存文件。

## 层次与状态

- Domain：C03、输入/交付记录、工作表目录、检查结论、单元格补丁与汇集请求。
- Application：DeliveryStorePort、SpreadsheetEnginePort、DeliveryApplicationService；检查 actor/thread、输入归属、限额；输出先完整验证再 CAS 提交。内部版本 `parentVersionId` 追踪，用户与 Run 来源区分。
- Store：独立 SQLite 表与二进制内容，事务同时提交字节、不可变元数据、idempotency 与 head。受保护数据目录，与 Artifact 到期表完全分离。单任务限额与总存储 admission 避免无限增长；不进行自动过期删除。SQLite 本地部署为首版，生产远程存储必须配置对应端口，否则不启用。
- 可复用 TypeScript 表格引擎：完整解包验证并保留模板 ZIP 内容，定向更新 XML 单元格；不通过会损坏未识别格式的整书重建宣称保真。检查全部公式，首版支持有限确定性公式；未支持公式明确阻止处理。具体语法和拒绝结构由实际行为测试固定。
- Control：独立 `/api/v1/threads/:threadId/delivery` 路由；上传、目录、分页读取、汇集、补丁、版本下载。身份/CSRF 复用现有链路，bodyLimit 独立覆盖，未知字段 fail closed。
- Worker：bounded delivery 工具，输入读取、汇集与补丁复用同一服务，Run 来源由执行命令绑定；在已有工具组合中最小接线。恢复用相同幂等键，不重新覆盖 head。
- UI：任务内专用文件面板；选择原件/模板、显示所有工作表、显式映射、真实交付清单、表格页与版本下载，单元格编辑和冲突后重新加载。请求按 threadId/AbortSignal 隔离；处理时保留已保存版本。

## 数据、处理与验证

上传保存完整原字节并附所有工作表维度；不把正文注入会话。分页最多 100 行且总响应至多 16 KiB，下一页位置明确。汇集以来源 sheet/headerRow 与列名映射为规则，遍历全部选择行，不隐含前三张表。空行可明确排除并计数；缺失表头/重复映射等阻止提交。保留来源计数、数值列合计及异常。单元格写入只改变显式范围；公式和值分别编码，CSV 公式样字符串作为数据保留。

修改采用 `(deliveryId, expectedVersionId, expectedContentDigest)` 原子比较。成功创建新 versionId，历史版本保持可下载。重试幂等键相同且内容一致返回原结果，参数不同冲突；数据库事务失败没有 ready 记录。文件实际 bytes/hash 不符视为损坏，不用验证标签掩盖缺失。

## 兼容、恢复与风险

C03 为全新增包导出与路由，旧 Artifact schema、toolOutput read、retention 不改。新工具结果正文可以包含 C03，但 UI 必须从授权文件目录读取确认。已有附件文本抽取用于普通问答；完整文件任务使用新上传入口并明确范围。服务重启直接恢复数据库已提交 head；写入中断 rollback；跨进程 CAS 防止用户更新被 Worker 覆盖。客户端刷新先取目录，预览下载绑定明确版本，旧响应不能切入新任务。

首版不承诺任意 Excel 功能；未知 ZIP part、外链、宏、复杂透视/图表等需要明确拒绝或有证据保持。公式验证是实际受支持语法计算，不依赖陈旧缓存；未验证不标通过。加密/共享远程 store 与更多格式后续扩展，不能因此扩大首版运行时。

## 自检与接线记录

跨 feature 仅 C03 权威类型/解析器；不占用 F02/F03/F04 模块。公共入口限 domain/application/store exports、Control composition/routes、Worker composition、UI 任务面板及依赖 lockfile。必要新增依赖统一由 F01 root 修改并记录许可证；实现前先写行为测试。真实模型 GUI 和恢复证据分栏验收。
