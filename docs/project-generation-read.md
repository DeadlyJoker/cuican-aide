# 保存的项目生成：只读恢复

状态：Control、Application、SQLite/PostgreSQL 和公共客户端已实现。SDK、插件页面读取、主动查询供应商及图片选用尚未接入。

## 公共入口

`GET /api/v1/creative-projects/{projectId}/concepts/{assetId}/revisions/{assetRevision}/generation`

只接受三个保存源定位字段，不接受 query、执行插件、Run、付款人或账户字段。客户端通过 `client.creativeProjects.getConceptGeneration(locator)` 调用原认证、超时与取消链路。没有关联时返回 `{ generation: null }`；没有本人源读取权限时沿原授权错误返回，不借空结果隐藏拒绝。

服务端先通过真实 CreativeProjectApplicationService 核验当前本人及源读取权限，再按原不可变关联派生执行插件和 Run，复用 ExtensionReadApplicationService 的当前任务、配置、Run 和插件权限检查。核验原 binding、完整付费受理回执、保存描述及需求摘要。历史读取不要求项目 active、最新输入或当前元数据 CAS；归档、取消和积分释放不会删除已受理的生成关联。最后任务读取等待结束后再次检查项目源权限。

这是读取已保存事实的路径，不调用 Node 或供应商，不创建 Run，不报价、不冻结积分，也不变更选图状态。各授权端口仍是原独立检查，不能据此声称跨多个异步授权服务的全局原子快照。

## 返回结果

沿原任务投影返回 Run 状态及保存的 operation 观察。Run 状态与供应商 operation 状态分别展示。任务级 `sourceRunId` 固定为 null，operation 的来源仍是原生成 Run。

每个 operation 包含自己的 `operationRevision`；每张已核验图片包含原 `images[]` 的 `resultIndex`。响应裁剪不重编号，跳过前面的图片时必须标记 `truncated`。完整 JSON 响应上限为 60KiB，每次最多 16 个 operation，每个最多 16 张图片。响应不提供结果选用权限，后续仍须服务端核验确切观察版本与图片身份。

## 显式启用

独立读取配置为 `creativeProjects.generationReads: { version: "crewon.project-generation-read.v1" }`。只读 Store 的 `enableProjectGenerationReads()` 验证已经存在的原 Extension、项目元数据和生成关联 schema、版本及约束，不创建表，不启用生成写能力。冷打开需要重新明确启用；未知版本、缺失 schema 或 provenance 损坏均拒绝。

已有明确的付费 `pluginGenerations` 装配，在原写迁移完成后启用此读取适配器。默认装配继续关闭此 GET，没有额外迁移或源读取。本机管理/standalone 的付费生成禁止规则不变，只读能力不能派生执行或付款身份。

## 验证边界

真实 SQLite 和隔离 PostgreSQL 18.6 覆盖冷恢复、原回执损坏、缺失关联行、历史归档及单连接池实际 Application 读取；Control 实际 HTTP 覆盖原身份、任务权限、严格定位及 operation 原始索引。测试夹具不代表人类生产身份、钱包、真实供应商生成或正式 App 闭环。

测试及清理证据见 `output/extensions/checks/project-generation-read-proof-20261003.json`。后续顺序仍是 SDK/Host 读取、插件页面生成与恢复、原 operation 显式查询、确切结果选用。
