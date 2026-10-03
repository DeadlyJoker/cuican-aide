# 概念图结果选用协议

日期：2026-10-04。状态：独立协议、Domain/Application、SQLite/PostgreSQL 存储、HTTP/BFF/Client、SDK、实际已安装 UI owner 与独立短剧 7.0.0 页面已接通并通过分层验证；完整 App 在线流程及进程重启后的 UNKNOWN 持久恢复仍在推进。

## 范围

用户从原生成结果中明确选择一个 operation 的一张图片。选用保存独立的结果关联、当前指针和命令回执，不创建 Turn 或 Run，不访问供应商，不冻结或结算积分，不改变原项目、素材元数据和输入修订。

原生成、原操作查询、设置、账号、侧栏及页面样式保持原行为。通用层仅保存经过服务端核验的图片引用；ComfyUI 的输出文件、子目录和 URL 算法属于供应商适配器。

## 公开接口

新增独立服务 `crewon.project-generation-selections@1`，提供两个 UI action：

- `crewon.project-generation-selections.v1.getConceptSelection`
- `crewon.project-generation-selections.v1.selectConceptImage`

声明服务不授予权限。旧包不需要声明此可选能力；新版包是否具备实际能力由真实宿主装配决定。

HTTP 读取和写入使用同一路径：`/api/v1/creative-projects/{projectId}/concepts/{assetId}/selection`。GET 只接受空 query；PUT 延用原认证、Origin、CSRF 和 `Idempotency-Key`。请求、响应均不超过 24 KiB。

写入请求体：

```ts
{
  reference: {
    projectId,
    assetId,
    assetRevision,
    expectedProjectRevision,
    expectedAssetMetadataRevision
  },
  operationId,
  expectedOperationRevision,
  resultIndex,
  expectedSelectionRevision
}
```

路径必须与 reference 的项目、素材一致。UI action 另带 `idempotencyKey`；HTTP 请求体不带该字段。客户端不能指定 URL、文件引用、Run、插件、配置、身份、付款人、价格或供应商参数。

`resultIndex` 是原持久化结果 `images[]` 中的索引，范围 0–15，不采用显示列表、分页或裁剪后的顺序。服务端加载确切 operation，不能只查任务投影中的前 16 条 operation。只有 succeeded 且 operation revision 完全一致的原结果可被选用。

`expectedSelectionRevision` 必填，首次选用为 0，后续为当前选用版本。它与项目、素材元数据 CAS 分开；不接受不安全整数或无法递增的最大整数。并发选择相互冲突，不能静默覆盖。历史输入可以使用当前 active 项目和元数据 CAS 选用。

写入响应是不可变命令回执：

```ts
{
  disposition: "committed" | "replayed",
  selectionRevision,
  selection: {
    reference: { projectId, assetId, assetRevision },
    operationId,
    operationRevision,
    resultIndex,
    filename,
    url,
    selectedAt
  }
}
```

其 selection revision 等于请求中的预期版本加一。旧 key 重放返回原回执，不覆盖后来选中的图片，也不将原回执宣称为当前指针。客户端随后单独读取当前状态：

```ts
{
  selectionRevision,
  current: null | { ...selection, requiresConfirmation }
}
```

revision 为 0 当且仅当实际当前指针为空。未配置能力、未迁移或不完整 schema 是错误，不能伪装为空。读取允许归档和历史输入，继续检查当前项目、原执行插件与 Run 的读取权限。

宿主另提供可选的 `props.data.projectGenerationSelectionContext` 恢复提示，版本为 `crewon.project-generation-selection-host-context.v1`，字段仅为 `version` 与 `intent`。intent 为 null，或包含完整原 request、`pending/uncertain/accepted/refused`、retryable 及原不可变 receipt；只有 uncertain 可以重试，只有 accepted 携带匹配原请求的回执。整个提示最多 24 KiB，拒绝 getter、额外字段及客户端构造的当前指针，不包含 Thread、运行范围、账号或付款信息。它不授予能力；新写仍沿真实当前挂载和原服务授权。

选用恢复保留原账户与完整 source pin 审计，同一包的停用后重新启用可以使用当前真实有效的挂载显式重试原 key 和原输入；包、发布者、版本或贡献变更不能替换未知请求。此规则不改变原生成和查询 journal 的 pin 规则。accepted 回执与当前指针分开，页面必须另行 GET 当前选用；宿主不会用原回执覆盖较新选择。独立短剧 7.0.0 的页面控件与账户 journal 已接通；同一运行中重挂的恢复不代表应用进程重启后的持久恢复。

首次实际派发收到明确的项目、素材、operation 或选用版本冲突时，journal 可以记录 refused；页面显式读取真实元数据与当前指针后等待下一次用户点击，不自动重基或提交。已有 UNKNOWN 的原请求随后得到相同冲突也不能证明先前未提交，必须保留原输入和原 key。网络错误、回复缺失、超时或坏响应继续保持 UNKNOWN；已确认的回执不会回退。

`requiresConfirmation` 只比较选用输入与最新素材输入、所依赖需求与最新需求。修改描述或需求后，旧选用保留并提示重新确认；项目重命名不使选用过期。选用时间用于审计，版本承担顺序，时钟回拨不造成伪版本冲突。

## 来源与事务

Application 从本人范围的生成关联派生原 Run、binding、原付费准入和冻结配置，核对原任务回执，再按确切 operation ID 读取原始结果。浏览器不能提交执行或结果来源证明。

服务端显式注册同步、纯 `ProjectGenerationImageResultVerifier`。通用层检查来源、成功状态、索引及结果边界，供应商适配器检查冻结的 plugin/version/manifest/implementation 和结果格式。原结果不超过 16 KiB；内部 opaque provider reference 是不超过 2 KiB 的 canonical JSON。公开结果保持原任务投影的 HTTPS、无凭据、无 fragment 和 2048 字节边界，URL 使用原核验后的 canonical 值，不保存媒体字节。通用显示文件名非空、最多 1024 个 UTF-16 单元、无控制字符及孤立代理项，保留供应商值，不套用用户标题的去空白规则。

ComfyUI 适配器保留原严格规则：最多 16 张图片，exact `filename/subfolder/type/url`，仅 output，拒绝路径穿越与控制字符；URL 必须等于根据原冻结 HTTPS 根地址重建的 `/view` URL。内部引用保留 filename、subfolder、type；公开投影只暴露文件名和已核验 URL。

Store 在同一数据库事务中重读元数据、原生成和付费回执、原配置与 activation、确切 operation 的索引列和 JSON，再次运行纯 verifier，原子写入不可变 OperationResultLink、独立当前指针和不可变选用回执。PostgreSQL 复用原项目锁，并锁实际 operation 行；不在已借用连接时再借连接。

命令来源必须显式区分：正式认证 HTTP 命令使用 `authenticated-project-command`；已安装插件 UI 使用 `installed-plugin-ui`，必须携带宿主实际捕获的 publication、source pin、selection 和 package，并在同一连接核验与锁定。未知、缺失或伪造来源不降级为另一分支。

完整权限和安装复核在事务前执行；事务内只使用已借用 SQL 连接及无需额外 SQL 的外部策略、身份、档案和调用存活复核，COMMIT 前有同步 active fence。重放先查回执，跳过旧请求的当前元数据 CAS，仍核对来源与原事实。COMMIT 后仅验证不可变事实，不让随后撤权或关闭改写已确认结果。

## 迁移和验收

新增独立选用 schema、三张业务表及不可变性约束；原 metadata mutation kind、旧 receipt CHECK、原 generation/query link 和任务协议保持原样。迁移、写入和只读能力显式开启，默认关闭；只读加载已有 schema 不开启新写入，未知或部分 schema 拒绝使用。

验收依次覆盖协议与仓外 SDK、真实双库及单连接池、HTTP 和真实已安装 UI owner，再接短剧控件及丢回复恢复。需要证明旧 key 重放不回退新指针、正确 operation/index、并发 CAS、归属和撤权、事务回滚、进程冷恢复与无新的收费提交。最后在完整原 App 中完成在线生图、查询、选用和重启恢复，不能用分层测试代替完整 S0 结果。
