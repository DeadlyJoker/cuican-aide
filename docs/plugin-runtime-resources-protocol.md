# Node 插件运行期资源协议

状态：源码与专项验收已实现；未发行到正式桌面包。此接口落实 DSH/Cordis 的资源归属和撤销思路，仍使用 CrewON 原宿主、服务授权和 Run 绑定。

## 兼容范围

`crewon.plugin-host.v1` 的 Node Context 新增可选 `resources`（接口 `apiVersion: "1"`），从 `@crewon/plugin-sdk/node` 导出 `PluginRuntimeResources` 与 `PluginOwnedResource<T>`。旧插件不使用此字段可继续运行；新插件在旧宿主必须先检测该字段和版本，缺失时明确报告能力不支持，不能静默使用不受管理的替代实现。包描述、服务声明、原身份与摘要语义不变。

`onDispose` 保持初始化阶段登记清理的原语义；运行期资源使用新的 `acquire`，不移除原注册边界。

```ts
if (context.resources?.apiVersion !== "1")
  throw new Error("runtime_resources_unsupported");
const handle = await context.resources.acquire(async ({ signal }) => {
  const subscription = await authorizedService.subscribe({ signal });
  return {
    value: subscription,
    dispose: () => subscription.close(),
  };
});
// 需要提前释放时可 await handle.dispose()；实例退出也会统一清理。
```

该接口不签发网络、文件、工具或业务授权。工厂内的服务调用仍需通过原宿主授权；这仍是可信同进程 Node 模式，不是恶意代码沙箱。

## 生命周期与边界

1. 宿主先登记获取过程，再调用工厂；初始化、准备及接受调用阶段可获取。最多同时拥有 512 个未完成获取或未成功清理的资源；成功清理释放容量。
2. 停用、替换或宿主关闭会撤销新获取并中止传入工厂的 signal，包括还在初始化中的实例。已经完成的资源随实例保留，直到原借用释放后才统一清理。
3. 忽略取消信号的工厂晚到返回时，宿主先清理该资源，再拒绝其获取结果。物理获取尚未结束时，不能把实例报告为清理完成；接口不以超时伪造结束。
4. 实例清理等待所有获取结束，然后按获取登记顺序的逆序清理资源，最后执行原初始化清理回调。并发工厂完成顺序不改变归属顺序。
5. 同一个句柄的提前释放和宿主清理共享一次清理任务。失败不会自动重复执行有副作用的清理；错误保留在实例 `cleanupFailed` 状态，依赖租用继续保留。
6. 已撤销或保留的实例不能再获取新资源。历史 Run 已有的资源继续按租用保留；若历史执行需要新的获取，必须另行设计绑定原 Run 的作用域与授权，当前接口不冒充该能力。

开发者必须为实际获取提供正确的清理函数，不能在工厂返回之前丢失已获取对象。清理只处理运行时资源，不撤销持久业务事实或已提交的外部请求。

## 证据与剩余工作

NodeHost、可选服务、服务绑定、准备事务与资源所有者专项 52/52，通过，零跳过。真实安装的 ESM 入口覆盖运行期获取、借用保留、初始化中撤权、晚到资源清理和清理失败的实例栅栏；同时覆盖容量与逆序清理。SDK 全部 87/87 通过，包括仓外离线包及无 DOM/Node 环境声明验证；接口复用可移植的 `PluginAbortSignal`，实际传入 Native AbortSignal。Host 类型检查通过。这里没有线上供应商请求或正式 App 验收。

尚待：公开 SDK 发布版本、仓外开发模板验证、逐服务依赖重协调、历史 Run 获取作用域、正式桌面升级和无插件基础聊天验收。
