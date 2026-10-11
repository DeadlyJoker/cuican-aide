# Node 宿主服务目录

业务插件通过公开 SDK 的 `context.services.get(service, apiVersion)` 使用已声明的 Node 依赖。宿主通过 `@crewon/plugin-host` 的版本化目录，将真实服务实例和组合身份一起交给 NodeHost 与组合发布者。UI 服务可用性探针属于 UI 装配路径，不能成为 Node 实现。

这份文档描述已实现的库接口。正式桌面安装 profile 当前仍采用空 Node 宿主服务集合；加入目录库不等于已经在正式安装、授权和执行路径接通这些服务。

## 已有核心实现

| Node 服务          | API 版本 | 实现身份                       | 实现修订 | 行为与授权边界                                                                                                                         |
| ------------------ | -------- | ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `crewon.execution` | `1`      | `crewon.execution-registry.v1` | `1`      | 在真实插件 setup 中注册 ToolRuntime 工厂。获取工厂要求实际 NodeLease；创建与关闭 ToolRuntime、Run 配置和每次工具授权仍由 Worker 管理。 |
| `crewon.tasks`     | `1`      | `crewon.task-action-bridge.v1` | `1`      | 通过当前 UI action 的短期 `invocationRef` 创建任务。引用与真实插件实例绑定；请求不得自带 actor、payer 或授权信息。                     |
| `crewon.tasks`     | `2`      | `crewon.task-action-bridge.v1` | `1`      | 保留 v1 的创建任务行为，增加基于原始 Run 与 operation 的任务查询。查询仍检查实际实例、原始绑定与当前授权。                             |

服务 API 版本与实现修订是两个维度。API 版本描述插件可消费的 ABI；实现身份/修订描述被批准的宿主行为。行为改变时必须显式分配新修订，并保存到新组合中。目录身份不代替包摘要、原始 Run 绑定、当前授权或构建证明。

SDK 的 task 类型见 [task-action-types.ts](../packages/plugin-sdk/src/task-action-types.ts)；执行类型见 [tool-runtime-types.ts](../packages/plugin-sdk/src/tool-runtime-types.ts)。插件仍必须在 `crewon.plugin.json` 的 `requires` 中声明准确的服务与 API 版本；未声明依赖和错误版本均不会被兼容猜测。

## 宿主装配接口

[目录接口](../packages/plugin-host/src/plugin-node-host-service-catalog.ts)提供：

```ts
capturePluginNodeHostServiceCatalog(registrations);
// 返回同一份不可变的 registrations、metadata、implementations。
```

每项 registration 包含 `metadata: PluginCompositionHostService` 和 `implementation: PluginHostService`。目录拒绝重复服务/版本、身份与实现错配、非法修订、访问器和超限输入；实际服务 value 保留原来的所有者和可变状态，绑定方法捕获原始接收者。目录没有安装、借用、任务调用或授权能力。

[核心服务适配器](../packages/plugin-host/src/plugin-core-node-host-services.ts)仅接受具有真实私有字段身份的实现所有者：

```ts
const registry = new PluginExecutionRegistry();
const catalog = capturePluginNodeHostServiceCatalog([
  createPluginExecutionHostServiceRegistration(registry),
  ...createPluginTaskHostServiceRegistrations(actualTaskBridge),
]);

const nodeHost = new PluginNodeHost({ services: catalog.implementations });
// 同一 catalog.metadata 用于当前宿主的组合发布；
// 同一 catalog.registrations 用于组合协调器。
```

`actualTaskBridge` 必须先由真正的任务 application、profile owner、当前选择投影、授权服务及已提交回执 authority 构造。缺少这些依赖时不得添加 tasks 身份，亦不得把 `isAvailable()` 的 UI port 包装成 Node service。保存组合元数据仅说明构图成功；插件实例就绪需要真实 prepare/commit 与当前身份、权限的再检查。

目录不接管所有者生命周期。先撤回新接入与依赖贡献，再等待实际 Node 借用和清理完成；registry 与 task bridge 的关闭由创建它们的宿主负责。历史任务必须保留原服务身份与原实例，不能根据今天的目录重写原组合。

## 行为验证范围

新增覆盖包含真实安装后的 ESM setup、工厂注册与租约清理；目录内 task bridge 经真实 UI invocation、SQLite 提交与第二连接回执重放，并在实际 quote await 期间撤回授权后验证没有新 Turn、Run 或积分占用。还覆盖伪造原型/代理、猜测 invocation、UI 权限拒绝、关闭 owner、访问器与身份错配。

这些测试使用临时目录和测试 profile；不能替代正式桌面的服务批准、安装生命周期、Worker 装配或跨进程故障恢复验收。
