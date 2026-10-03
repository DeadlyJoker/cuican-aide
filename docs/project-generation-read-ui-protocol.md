# 保存生成的插件只读协议

本协议将[原保存生成服务](./project-generation-read.md)接到独立插件 UI，沿用原 `services.invoke` 和安装模块动作路由。它不改变原 `crewon.project-generations@1` 的唯一生成动作，也不增加任务回执类型、Node 服务或供应商状态机。

## 请求与响应

服务是 `crewon.project-generation-reads`，API 版本是 `"1"`，唯一动作是 `crewon.project-generation-reads.v1.getConceptGeneration`。公开 SDK 入口为：

```ts
import { createPluginProjectGenerationReadClient } from "@crewon/plugin-sdk/ui";

const reads = createPluginProjectGenerationReadClient(services);
const result = await reads.getConceptGeneration(
  { projectId, assetId, assetRevision },
  { signal },
);
```

输入只接受这三个保存源定位字段。SDK 在等待前复制严格输入并固定真实 dispatcher 和本次 signal，拒绝额外选择器、accessor 和未知字段，不探测、启用服务或自动重试。取消会清理监听并观察迟到失败，不能使迟到结果交付页面。

响应使用现有 `GetConceptGenerationResponse`。没有该版本关联时为 `{ generation: null }`；当前权限拒绝、服务未装配和损坏历史均保持错误，不伪装成没有生成。完整 JSON 上限为 60KiB，保留原 Run 和 operation 的分别状态、`operationRevision`、图片原始 `resultIndex` 及 `truncated`。插件提交的 Run、目标包或 URL 不参与原任务查找。

## 显式装配

Production 只有在明确配置 `creativeProjects.generationReadUi: { publications }` 时组装只读动作 owner；每个 publication 固定实际业务包 `pluginId`、`packageDigest` 和 `contributionId`。它还要求已有 `generationReads` 配置、原项目服务与原任务读取服务。元数据批准或付费生成映射不自动批准只读 UI，默认路径保持关闭。

Host 仅对实际批准的 `main.content` 模块及确切 requirement `crewon.project-generation-reads@1` 提供可用性。未知协议版本、错误包或贡献以及 owner 关闭均拒绝。optional requirement 可以保持模块可用，但不把服务变为可用。普通元数据与付费生成继续各用原 owner；未知只读命名空间动作拒绝，不能回退到 Node 派发。

每次 HTTP 动作使用原 Production 身份和 profile 的 configuration-only scope。原任务 reader 必须绑定相同真实 request owner；只读 scope 在运行时和类型上拒绝 execution preparation。读取前后核对当前 actor、profile、UI invocation、原 source 权限和 task 权限。取消、挂载撤回、已观察的拒绝或 owner 关闭使未交付响应失效，close 等待物理读取结束；它们不取消历史 Run 或改动积分。

## 独立短剧模块

4.0.0 包只增加保存输入版本的生成记录区域，将读取 requirement 声明为 optional。选中确切已保存版本后读取原任务；编辑中不展示旧版本的结果，换版本、项目或关闭页面时撤回旧请求。服务不可用与没有记录使用不同状态；手动刷新仍只是读取保存观察。

结果区域复用模块已有样式，分别展示原任务与供应商 operation 的已保存状态，并保留原结果索引。它不增加生成按钮、供应商轮询、任务导航或选图写入。共享 CSS、应用 shell、账号菜单和设置保持原入口与原组件。

## 验证边界

公开 SDK tarball 的独立离线消费者覆盖纯 ES2022 契约、DOM helper 编译和实际调用。4.0.0 编译 ESM 的 DOM 测试证明保存版本切换、取消与迟到响应隔离；其测试 dispatcher 不代表真实 Host 或供应商。

Host / Control 的实际安装及 SQL 专项与独立模块证据分别记录，不能互相替代，也不代表生产用户、个人钱包或正式 App 在线生成。后续仍需真实生成控件与原线程准备、原 operation 显式查询和确切图片选用；完整目标尚未完成。
