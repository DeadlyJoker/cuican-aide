# 生成图采用服务与 V2 素材读取协议

2026-10-07，接续[已采用角色图接入生成输入](./adopted-media-generation-input.md)。共享采用服务、V2 公开投影和实际插件 UI 调用 owner 已实现。它们使用原资产、结果和事务存储，不新建插件包；正式 Control / Worker、插件页面与 Agent 接线仍待完成。

## 共用采用命令

`ProjectAssetMediaAdoptionApplicationService.adoptReference` 接收项目、角色及版本、原生成 Run 和输出序号、已保存候选 ID / 摘要、幂等键。调用方不提供 URL、图片字节或来源证明。原 Store 在提交连接上验证项目归属、原生成历史、候选、内容依赖和素材版本，然后原子保存参考版本、更新当前参考并写入回执。

调用需要实际宿主调用上下文以及三个分别成立的权限：`creativeProject:write`、`projectMediaResult:read`、`projectAsset:adoptMediaReference`。保存结果和读取结果不能代替采用权限；同键重放也重新检查权限。调用上下文的安装信息原样传入 Store，继续在事务中校验。

PostgreSQL 在提交前调用独立的事务权限检查；该检查不得重新借用当前 Store 的连接池。SQLite 持有同步事务时使用 `assertActive` 检查当前权限和生命周期，不在事务中等待异步回调。取消、权限撤回或调用上下文失效应阻止提交并回滚。提交完成后返回已持久化回执，不再读取可变素材头来覆盖原结果。

恢复同一采用命令会返回原参考版本。用户后来改选参考、锁定或修改内容时，旧回执不会再次修改当前选择。这个操作不会生成图片、下载图片、启动 Run 或扣费，也不会自动保存尚未保存的供应商结果。采用元数据本身不承诺图片档案现在仍可读取；预览和后续素材准备继续使用各自的真实档案检查。

## V2 公开协议

`@crewon/contracts/project-assets-v2` 提供原 11 个素材动作的 V2 版本，另增加 `adoptMediaReference`。读取与采用包含：

- `crewon.project-assets.v2.getAsset`
- `crewon.project-assets.v2.getReferenceRevision`
- `crewon.project-assets.v2.listReferences`
- `crewon.project-assets.v2.adoptMediaReference`

V2 参考的 `source.kind` 区分 `concept-selection` 与 `media-result`。媒体来源仅公开候选、原 Run / 输出、生成输入、工作流、原角色与参考版本及观察时间；不公开身份、租户、档案路径、供应商地址、配置参数或执行授权。列表按原参考版本分页，允许同时读取两种来源。

旧 `crewon.project-assets.v1.*`、公开投影及解析行为不变。V1 概念图仍可读取；V1 对新媒体参考继续明确拒绝，不能把它转换成假概念图。新公开协议单独协商版本，不能通过更新 SDK 或覆盖旧包来强行启用。内容编辑、锁定和历史改选均已在实际 V2 UI 调用链路验证；正式页面切换还必须接好恢复日志、宿主组合和新版协议客户端。

原插件描述符要求 `requires` 中的服务名唯一，不能同时声明 `crewon.project-assets` 的 1 和 2。因此 V2 已补齐原 11 个素材动作的完整映射、兼容响应与实际调用权限，再加上采用动作。插件仍只声明一个素材服务版本。此约束来自原 `packages/contracts/src/plugin-package-contract.ts`，不修改 SDK 或原描述符规则。

`ProjectAssetV2ApplicationService` 使用原资产服务完成授权读取，并将采用操作交给共用采用服务。公开解析器继续检查项目/角色身份、选中指针、来源内容、请求版本、候选摘要和分页游标。公开读取响应有字节上限，列表只裁剪完整记录。Agent 适配层仍须沿用分块内容读取和有限摘要，不能直接把整个 UI 响应注入模型上下文。

## 验证与下一步

证据目录：`output/extensions/checks/asset-media-adoption-public-v2-20261007/`。集成测试使用原安装处理器产生的 T10 结果、真实采用 Store、SQLite / PostgreSQL 和原资产服务，验证采用后读取、两种历史来源、独立权限拒绝、SQL 中撤回、取消和新连接回执恢复。合同测试覆盖来源混淆、额外权限字段、访问器、身份/版本不一致和无效分页。供应商和策略决定为具名夹具，没有调用真实 ComfyUI。

新增与回归用例共 62 项通过，无失败、无跳过，其中新增服务用例 8 项、V2 合同用例 5 项。Contracts、Application、RuntimeWorker、ControlAPI 类型检查，以及仓库边界和格式检查通过。临时 PostgreSQL 已停止并清理。

后续增量已完成[实际插件 UI 调用与素材历史切换](./project-asset-v2-plugin-ui.md)。下一步补齐 V2 恢复日志、正式宿主组合与 Agent 的 Run 上下文，再接入插件内的“采用为角色参考”操作、兼容的素材读取与历史选择。随后完成桌面 Control / Worker 的媒体来源组合及真实混合 D18 执行。原主题、侧栏、账号设置、SDK、冻结插件包及用户安装 App 在本增量保持不变。
