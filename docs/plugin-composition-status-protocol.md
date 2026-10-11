# 插件组合状态查询 v1

`GET /api/v1/plugins/composition/status` 是可选、已鉴权、只读的 HTTP 诊断接口。只有 Control 宿主显式配置实际 profile 的 `PluginCompositionStatusControlService` 才注册；没有 owner 时保留原 `404 route_not_found`。新增接口不默认启用插件，不更改原安装/选择回执，不解除历史组合 v1 任务查询的拒绝条件。

## 元数据与实际 Node 状态

响应固定版本为 `crewon.plugin-composition-status.v1`，包括独立的 `metadata`、分页 `plugins` 和 `next`。每项保留原公开 `PluginSelectionView`，并给出 `node` 状态。

- `metadata.unobserved`：未取得元数据发布观察。
- `metadata.published`：已提交图的摘要和修订；不能表示运行就绪。
- `metadata.failed`：固定分类码 `plugin_projection_pending` 或 `plugin_composition_metadata_unavailable`；不返回内部异常。
- `node.inactive`：选择是 disabled 或 uninstalled，已撤下新准入；不宣称旧借用或资源已经清理。
- `node.unobserved`：选择是 enabled，但实际 owner 没有足够的当前实例观察。
- `node.preparing`：实际 owner 观察到对应选择正在准备。
- `node.ready`：实际 owner 验证当前选择、身份和权威，并观察到精确选中包的当前 Node 实例 accepting。
- `node.waitingDependency`：实际 owner 取得必需依赖不可用的证据，固定分类码 `plugin_dependency_unavailable`。
- `node.failed`：实际 owner 取得激活、清理、权威或组合失败的证据；仅返回预定义分类码。

`node` 明确表示 Node 生命周期，不将 UI 可用当作 Node 服务实现，不承诺任务执行或借用权限。原服务调用仍实施各自的准入检查。元数据事务失败可以与既有实际 Node 实例 accepting 同时发生，因此响应没有强迫两者状态相同。

状态解析器拒绝把 disabled/uninstalled 选择报告成 ready、preparing 或 waitingDependency；实际 owner 仍可用 `node.failed / plugin_cleanup_failed` 如实报告停用或卸载后的清理失败。已启用但缺少观察的插件不能由 HTTP 层猜测失败或依赖缺失，也不能从 published 元数据推导 ready。

## 身份、边界与分页

路由先沿原 Control 身份入口解析 actor，再解析查询；无有效身份不会调用状态 owner。查询沿用原 `afterPluginId` 和 `limit`：默认 20，最多 50，必须严格排序前进。客户端不能指定 tenant、space、profile 或 epoch；重复参数、未知字段和非法游标拒绝进入 owner。

实际 profile owner 负责读取前后检查 actor、scope、当前权威、profile ownership 和选择修订。仅完成 HTTP 鉴权不足以证明某个 profile 的状态，配置方不能提供跨租户的静态缓存替代实际 owner。这是 owner 端必须验证的实现要求；可选路由及传输测试本身不证明正式 profile 已完成绑定。

响应至多 64 KiB，最多 50 项，不返回凭据、账号作用域、安装目录、异常消息、宿主服务值或完整组合图。路由设置 `Cache-Control: no-store`，不提供共享缓存或跨账号历史状态。非法、超界或与查询不符的 owner 输出成为固定内部错误；owner 故障不能被改为空的“健康图”。

## 兼容与覆盖

原客户端继续使用原路径和 DTO。新状态 DTO 只从 `@crewon/contracts` 的 HTTP 入口导出，不进入 `@crewon/contracts/plugins` 的 SDK 能力入口。OpenAPI 及生成类型同步记录新增只读路径，原命令、回执和授权语义保持。

专项覆盖元数据与 ready 独立、选择与状态约束、顺序分页和容量、未知版本、私有字段与任意异常拒绝、访问器不执行、无 owner 的 404、身份先于查询/观察、owner scope 拒绝和故障不伪报成功。实际 Node 生命周期观察及正式 profile 接入仍须由该 owner 的行为测试分别证明，不能由这些传输测试代替。
