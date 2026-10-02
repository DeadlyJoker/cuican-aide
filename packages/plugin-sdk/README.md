# @crewon/plugin-sdk

CrewON 插件开发接口，当前版本为 `0.1.0`。插件可以在 CrewON 源码仓库外开发；SDK 的分发包包含 ESM JavaScript、TypeScript 声明、LICENSE 和 NOTICE，不依赖宿主源码、私有运行时包或 React。

SDK 可打包为本地 `.tgz`，供独立开发项目安装，尚未发布到 npm registry。业务插件的安装器目前接收预构建目录；SDK 的安装命令不表示业务插件已支持压缩包输入或正式页面安装。

## 三个公开入口

| 入口                           | 内容                                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@crewon/plugin-sdk/contracts` | 包描述契约、`parsePluginPackageDescriptor`、`parsePluginUiLease`、有界 `parsePluginUiJsonValue`，以及身份、生命周期、Node 上下文和 UI props 等纯类型 |
| `@crewon/plugin-sdk/node`      | `definePlugin`、`parsePluginNodeDefinition`、`PluginSdkContractError` 与 Node ABI 类型                                                               |
| `@crewon/plugin-sdk/ui`        | `defineUiPlugin`、`parsePluginUiDefinition`、`PluginSdkContractError` 与 UI ABI 类型                                                                 |

没有包根入口。包描述契约沿用 `@crewon/contracts/plugins` 的权威实现，构建时将其纯模块闭包打入 SDK。描述校验只检查结构，不读取产物字节、执行插件或授予权限。Node 入口的声明闭包无需 DOM 类型；UI 入口需要 TypeScript 的 `DOM` lib。

`definePlugin` 和 `defineUiPlugin` 验证并冻结入口定义，不调用 `setup` 或 `mount`。Node 版本标签为 `crewon.plugin-host.v1`，UI 为 `crewon.plugin-ui.v1`。

## 构建 SDK 并在仓外安装

使用 Node.js 24、pnpm 10。在 CrewON 仓库中执行：

```sh
pnpm --filter @crewon/plugin-sdk build
cd packages/plugin-sdk
mkdir -p ../../output/extensions/installable-plugins/sdk
pnpm pack --pack-destination ../../output/extensions/installable-plugins/sdk
```

`pack` 会通过 `prepack` 重新构建。将生成的 `crewon-plugin-sdk-0.1.0.tgz` 交给独立插件项目，再在该项目中执行：

```sh
pnpm add /absolute/path/crewon-plugin-sdk-0.1.0.tgz
pnpm add -D typescript@5.9.3 esbuild@0.27.7
```

独立项目使用 `"type": "module"`。TypeScript 可使用 `module` / `moduleResolution: "NodeNext"`、`strict: true`、`skipLibCheck: false`；Node 专用代码可设置 `lib: ["ES2022"]`，UI 代码加入 `"DOM"`。本仓库的分发测试实际执行了仓外离线安装、独立编译和编译后 Node 入口调用。

## Node 入口示例

独立项目的 `src/node.ts`：

```ts
import { definePlugin } from "@crewon/plugin-sdk/node";
import type { PluginJsonValue } from "@crewon/plugin-sdk/contracts";

export default definePlugin({
  apiVersion: "crewon.plugin-host.v1",
  pluginId: "example.echo",
  setup(ctx) {
    const greeting = ctx.services.get<{ greet(): string }>(
      "example.greeting",
      "v1",
    );
    const registration = ctx.services.provide("example.echo", "v1", {
      echo(input: PluginJsonValue): PluginJsonValue {
        return { greeting: greeting.greet(), input };
      },
    });
    ctx.onDispose(() => registration.dispose());
    return {
      dispose() {
        // 释放插件自己的资源；宿主也会调用上面登记的清理函数。
      },
    };
  },
});
```

上下文的 `identity` 是宿主提供的 `{ pluginId, version, packageDigest }`。依赖和服务提供声明只放在 `crewon.plugin.json`：本例的 `requires` 必须包含 `{ service: "example.greeting", apiVersion: "v1", optional: false }`，`provides` 必须包含 `{ service: "example.echo", apiVersion: "v1" }`。这些是示例服务名，宿主需要实际注册兼容的 greeting 服务；SDK 不提供它们。

`setup` 可返回 `void`、`PluginDisposable` 或对应的 Promise。`onDispose` 接受同步或异步清理函数。服务发现、声明核验、注册提交、失败清理以及升级时旧实例租约的保留由宿主实现，SDK 只定义调用接口。插件应登记自己获取资源后的清理操作；服务注册返回的 disposable 可用于撤销注册。

## 任务与动作 ABI

Node 和 contracts 入口导出 `CREWON_TASKS_SERVICE = "crewon.tasks"`、`CREWON_TASKS_API_VERSION = "1"`、`PluginTaskService`、`PluginTaskRequest`、`PluginTaskReceipt` 和 `PluginActionsService` 等纯类型。包需显式声明该任务依赖，宿主也必须实际装配对应服务：

```ts
const tasks = ctx.services.get<PluginTaskService>(
  CREWON_TASKS_SERVICE,
  CREWON_TASKS_API_VERSION,
);
const receipt = await tasks.createTask({
  invocationRef,
  threadId,
  expectedThreadRevision,
  idempotencyKey,
  input: { prompt: "A ceramic teapot by a sunlit window." },
});
```

`invocationRef` 由当前宿主在授权业务动作时签发，具有范围和有效期；插件不能自行生成授权引用，也不能传入 actor、principal、profile、付款方或价格。线程与业务输入仍须通过宿主检查。回执只有 `disposition`、`threadId`、`threadRevision`、`runId`、`messageId`、`configurationRevision` 六个字段，后续输出使用宿主原有 Run 事件与恢复路径。

动作服务以插件自己的 `pluginId` 和 API 版本 `"1"` 提供，类型为 `PluginActionsService`：`actions` 列出 `{ contributionId, action, kind: "read" | "generateTask" }`，`invoke` 接收 `{ invocationRef, contributionId, action, input }` 并返回 JSON。声明不会授予动作权限，客户端不能指定 Node 服务；宿主负责当前贡献、选择、包版本和每次调用授权。该 ABI 不增加 manifest 字段，也不把插件在 `setup` 时固定绑定到某个用户。

业务动作桥要求动作服务为普通数据对象 `{ actions, invoke }`，并捕获 `invoke` 后调用；动作声明中的 getter、隐藏字段和未知字段会被拒绝。这是该动作 ABI 的边界，通用 Node 服务的 `provide` 接口仍允许其他服务对象。

目前 SDK 已提供这些调用接口与独立安装后的 ABI 验证；它们本身不签发引用、不创建 Run、不扣款，也不表示业务动作桥已经装配。

## UI 入口示例

独立项目的 `src/ui.ts`：

```ts
import { defineUiPlugin } from "@crewon/plugin-sdk/ui";
import type { PluginUiProps } from "@crewon/plugin-sdk/ui";

export default defineUiPlugin({
  apiVersion: "crewon.plugin-ui.v1",
  pluginId: "example.echo",
  mount(root, props) {
    const paint = (next: PluginUiProps) => {
      root.textContent = JSON.stringify(next.data);
    };
    paint(props);
    return {
      update(nextProps) {
        paint(nextProps);
      },
      dispose() {
        root.textContent = "";
      },
    };
  },
});
```

完整 mount 签名为 `mount(root: HTMLElement, props, services)`，允许返回 Promise。返回实例必须包含 `update(nextProps)` 和 `dispose()`，两者可异步。props 包含 `schemaVersion: "crewon.plugin-ui-props.v1"`、`contributionId`、`theme: { mode, tokens }` 和 JSON `data`。

UI 服务只有 `services.invoke(action, input, { signal? })`，返回 JSON 值；动作必须由宿主映射并授权。接口没有客户端 actor、principal 或全局身份参数。实际挂载、主题传递、动作路由和 UI 隔离由宿主负责，SDK 中的类型和定义校验不代表页面已接通。

## 插件产物与宿主边界

以上是源文件示例。将 SDK helper 打包进插件产物，可避免安装目录需要额外解析 SDK 依赖：

```sh
pnpm exec esbuild src/node.ts src/ui.ts --bundle --format=esm --platform=neutral --target=es2022 --outdir=dist --out-extension:.js=.mjs
```

插件的 `crewon.plugin.json` 固定使用包协议 `crewon.plugin-package.v1`。入口相对路径必须指向产物，所有产物的真实字节长度和 SHA-256 必须列入 `files`；descriptor 自身不放入该 inventory。UI 入口还需声明对应贡献和合法 slot。完整包摘要由宿主核验实际目录后生成，不能用示例摘要代替。SDK 不是插件打包器、安装器或加载器，单独编译源文件不等于包已通过安装核验。

Node 插件运行在受信任的宿主进程中。公开 ABI 不是沙箱，也不提供文件系统、网络或权限隔离；安装信任、启停授权以及每次业务调用的身份检查由宿主负责。

任务 ABI 之外，当前 SDK 没有公开的 ToolRuntime、工作流、配置或计费服务端口。`services.get` / `provide` 只能访问宿主实际装配、且包中声明的命名服务，不意味着这些能力已经可用。
