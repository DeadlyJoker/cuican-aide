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

## 可选服务与同一包的多种宿主上下文

`services.getOptional<T>(service, apiVersion)` 只允许读取清单中具有相同服务名、API 标签且 `optional: true` 的依赖。该上下文没有兼容服务时返回 `undefined`；未声明、请求标签不符、把必需依赖当作可选依赖、实例已失效或服务绑定失败仍会抛错。原 `get` 保持严格行为，即使清单把依赖标为 optional，缺失时也不会返回 `undefined`。不要捕获任意 `get` 异常来推断服务缺失。

该方法在类型上可选，以保留旧宿主上下文的结构兼容。使用它的插件必须先检测宿主能力，缺少方法时明确拒绝启动：

```ts
if (typeof ctx.services.getOptional !== "function") {
  throw new Error("plugin_optional_service_api_unavailable");
}
const tasks = ctx.services.getOptional<PluginTaskService>("crewon.tasks", "1");
const execution = ctx.services.getOptional<PluginExecutionService>(
  "crewon.execution",
  "1",
);
```

同一个包可以将这两个服务都声明为 optional，在任务宿主中调用实际 `tasks`，在执行宿主中向实际 `execution` 注册工厂。服务是否存在不授予当前用户权限；调用引用、任务准入和每次执行授权仍由相应宿主核验。执行宿主没有任务服务时不能创建任务，任务宿主没有执行服务时不能假注册工厂。没有实际工厂注册的包也不能通过执行就绪检查。

清单中所有 `provides` 仍必须在每种上下文注册。若包声明自己的动作服务，应始终提供严格的 `{ actions, invoke }` 对象；缺少任务服务的上下文可以不列出任务动作，并在调用时明确拒绝。服务绑定及清理属于本次 `setup`，不要把某一上下文的服务保存为模块全局变量再供另一实例复用。准备期间可选服务的可用性变化仍会阻止发布。

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

动作服务以插件自己的 `pluginId` 和 API 版本 `"1"` 提供，类型为 `PluginActionsService`：`actions` 列出 `{ contributionId, action, kind: "read" | "generateTask" | "queryTask" }`，`invoke` 接收 `{ invocationRef, contributionId, action, input }` 并返回 JSON。声明不会授予动作权限，客户端不能指定 Node 服务；宿主负责当前贡献、选择、包版本和每次调用授权。该 ABI 不增加 manifest 字段，也不把插件在 `setup` 时固定绑定到某个用户。

`CREWON_TASKS_V2_API_VERSION = "2"` 和 `PluginTaskServiceV2` 在保留 `createTask` 的同时增加 `queryTask`。需要查询的包须声明 `crewon.tasks` API `2`，读取该确切版本；宿主可以同时提供 API `1` 和 `2`，原客户端继续使用 `1`。此支持限于可信宿主服务的版本共存，插件提供服务之间的原冲突规则保持不变。

```ts
const tasks = ctx.services.get<PluginTaskServiceV2>("crewon.tasks", "2");
const receipt = await tasks.queryTask({
  invocationRef,
  threadId,
  expectedThreadRevision,
  idempotencyKey,
  sourceRunId,
  operationId,
});
```

查询只传原 Run 和 operation 引用。宿主从持久原生成记录核验原包、配置、完整执行目标、已预留的个人报价和 operation 所属，再检查当前用户的来源读取及目标线程权限。查询保存独立 provenance，使用原包观察原结果，不新增生成报价或积分预留。当前 UI 可以来自新版本，但不能让历史执行换包；复制引用、旧用户权限或安装状态本身都不构成查询许可。没有真实查询 host 时明确拒绝。

业务动作桥要求动作服务为普通数据对象 `{ actions, invoke }`，并捕获 `invoke` 后调用；动作声明中的 getter、隐藏字段和未知字段会被拒绝。这是该动作 ABI 的边界，通用 Node 服务的 `provide` 接口仍允许其他服务对象。

目前 SDK 已提供这些调用接口与独立安装后的 ABI 验证；它们本身不签发引用、不创建 Run、不扣款，也不表示业务动作桥已经装配。

## 创作项目元数据 UI helper

UI 入口新增 `createPluginCreativeProjectClient(services)`，以原 `services.invoke` 提供项目、需求及概念输入修订的 14 个类型化方法；contracts 入口导出严格动作解析器与公开 DTO。输入最多 24KiB、响应最多 60KiB。helper 捕获实际 dispatcher 和本次 caller signal，取消后不交付迟到响应，并清理监听。

这套协议不包含生成或扣款，也不使 Host 服务自动可用；正式安装插件的 dispatcher、依赖可用性和 ready 仍待接线。当前项目归属也不是任意插件的数据 namespace。仓外 tarball 测试覆盖纯 ES2022 contracts、DOM UI 编译和全部动作调用。完整动作及宿主提交边界见[协议说明](../../docs/installed-plugin-creative-project-actions.md)。

## 执行工厂 ABI

Node 和 contracts 入口导出 `CREWON_EXECUTION_SERVICE = "crewon.execution"`、`CREWON_EXECUTION_API_VERSION = "1"`、`PluginExecutionService`、`PluginToolRuntimeFactory`、`PluginToolRuntimeContext` 与自持的 `PluginToolRuntime` 类型。执行工厂由宿主服务注册，不改变原有 `{ actions, invoke }` 动作服务：

```ts
import {
  definePlugin,
  CREWON_EXECUTION_SERVICE,
  CREWON_EXECUTION_API_VERSION,
  type PluginExecutionService,
  type PluginToolRuntimeFactory,
} from "@crewon/plugin-sdk/node";
import { createStoryTools } from "./tools.js";

export default definePlugin({
  apiVersion: "crewon.plugin-host.v1",
  pluginId: "example.story",
  setup(ctx) {
    const execution = ctx.services.get<PluginExecutionService>(
      CREWON_EXECUTION_SERVICE,
      CREWON_EXECUTION_API_VERSION,
    );
    const factory: PluginToolRuntimeFactory = { create: createStoryTools };
    const registration = execution.register(factory);
    ctx.onDispose(() => registration.dispose());
  },
});
```

`createStoryTools` 是独立插件自己的实现，返回 `PluginToolRuntime` 或其 Promise。包需要在 `requires` 中声明 `{ service: "crewon.execution", apiVersion: "1", optional: false }`；宿主必须实际提供该服务，并将注册绑定到正在加载的真实包身份。撤销注册停止新准入，已有执行实例的租用、保留结果和清理由宿主管理。SDK 不实现这个注册服务或 Worker 适配器。

工厂上下文由宿主核验持久 Run 后复制并冻结，包含以下元数据，不包含 Store、ActorContext、权限令牌或凭据值：

| 字段            | 内容                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `identity`      | 实际安装包的 `pluginId`、`version`、`packageDigest`                                                         |
| `scope`         | `tenantId`、`spaceId`、`profileId`                                                                          |
| `run`           | 原 `runId`、`threadId`、`bindingDigest`、`inputDigest`，以及可空的原 operation 来源 `source`                |
| `configuration` | 冻结的 `revision`、`contentDigest`、JSON `parameters` 和不含秘密的 `credentialBindings` 引用                |
| `target`        | 原执行目标的 AgentVersion、内容和物化摘要、authority、runtimeGeneration、policySnapshot 与 workspaceBinding |

上下文不是当前权限证明；持有它也不能创建新 Run、变更选择或读取其他用户数据。宿主适配器须核对实际包、原 v0 Run binding、配置、AgentVersion 与每次命令，并在外部副作用前执行当前授权检查。历史 Run 必须继续使用原包和原 operation 身份，不能改用当前最新选择。v0 schema 标签和原 Run 的 binding digest 均保持不变。

`PluginToolRuntime` 必须提供 `definitions`、同步 `executionPolicy` 和异步 `execute` / `reconcile` / `cancel`。命令完整保留 invocation、executionId、lease、actionDigest、ActionIntent 与 approvalProof；结果保留 `completed`、`canceled`、`unknownOutcome`，以及原 ToolResult 的输出、artifactRef 和可选 workspaceChanges。SDK 自持这些结构，不要求独立插件导入 Application、Domain 或 Tool-broker。

副作用必须声明 `mutation` / `reconcilable`。已派发操作在响应丢失或重开后应核对原 execution、idempotency、action 和请求摘要，使用 `reconcile` 查原 operation，不再次派发；取消或信号中止不能证明供应商副作用已经撤销。不确定结果应返回 `unknownOutcome`。供应商持久回执与去重仍由实际执行适配器负责，这些类型本身不保证 exactly-once。

可选方法完整保留原宿主能力：`reserveExecution` 返回 `execute` / `release` 句柄；`acknowledgeExecutionResult` 在宿主确认持久提交后释放本地结果证据；`retainedExecutionResults`、`scanRetainedExecutionResults`、`readRetainedExecutionResult` 和 `cancelRetainedExecution` 支持有界查询与本地取消。扫描和本地查询不得重新派发工具。`resultOwner` 只能由宿主传入，不进入模型输入。确认回执返回 `false` 时，宿主继续保留尚未物理结束的执行。

`canRetire` 是同步本地证明，仅在没有借用者时调用；缺少该方法表示未知，空扫描不证明可以退休。`close` 返回 Promise，适配器须在其完成前等待自身物理执行结束并妥善保留恢复证据。宿主不得在升级时提前清理旧 Run 所借用的实例。

执行方法的取消参数是 SDK 自持的 `PluginAbortSignal`：包含 `aborted`、`reason`、`throwIfAborted` 和 abort 监听的窄视图，不需要 DOM 声明。宿主应原样传入真实原生 AbortSignal；不能用仿造信号替代。拥有 Node 或 DOM 类型、需要调用 `fetch` 的插件可在自己的网络边界将这个原生对象断言为 `AbortSignal`，该断言不会生成或补齐实现。宿主仍负责 lease 失效、当前权限和网络策略。

工厂的可选第二参数为 `PluginExecutionServices`，原单参数工厂保持兼容。`approvalRequirement` 来自实际 Run 的宿主审批模式；可选 `externalOperations` 和 `jsonHttp` 提供原外部 operation 账本与受控 JSON 请求。这些端口不把数据库连接、调用者、付款人、凭据或任意网络 origin 交给插件。

需要 IO 的工厂应声明只读 `requiredServices`，例如 `{ requiredServices: ["externalOperations", "jsonHttp"], create: createStoryTools }`。Node 和 contracts 入口导出的 `PluginExecutionServiceRequirement` 仅允许这两个值；数组可以为空，不能重复。宿主注册时复制并冻结声明，实际租用工厂可读取该声明，并在执行插件的 `create` 前检查所需端口：`externalOperations` 必须具有 `reserve`、`load`、`advance`，`jsonHttp` 必须具有 `request`。缺失时以 `plugin_execution_required_services_unavailable` 拒绝，插件业务工厂不会执行。省略声明的旧工厂保持原行为。

声明与方法形状不授予 Run、网络或付款权限，也不证明部署就绪。宿主仍须核验真实配置、服务所有权和当前操作授权；插件自身也应检查运行时实际收到的服务。SDK 只提供类型，实际注册检查由宿主实现。

端口的 `command` 必须是当前 `execute/reconcile/cancel` 收到的实际命令对象。宿主在已持久派发并确认的 Worker claim 内开放调用范围；复制 DTO、只持有 Run 元数据、保存命令到调用结束后都不能取得 IO 权限。`reserve` 使用原 Run 的确定性 operation ID，持久创建成功才返回当前调用范围的一次性 `dispatchRef`；`existing` 不返回新凭证。`POST` 的方法、相对路径和 JSON 内容必须与预留摘要完全一致，凭证先消耗后等待，不因失败、重开或查不到结果再次发出。ComfyUI 等供应商的关联 ID 不等于其服务端去重保证。

`jsonHttp.request` 仅接受 `GET` 或 `POST`、已批准的相对路径和有界 JSON。服务 origin 来自已锁定配置；宿主检查当前 Run、包许可、DNS 和固定网络策略，在真正发送前再次检查。历史查询只能读取已准入来源的 operation，不能提交新操作。真正收到的供应商响应允许在迟到取消或撤权后写入同一 operation 的本地证据；新外部 IO 仍须重新通过当前授权。关闭等待实际 HTTP、Store CAS 和委托调用结束。

这些能力仍是可信进程内插件的协作协议，不隔离恶意 Node 代码。使用宿主 IO 端口的插件应禁止自己的直接网络请求，以便外部操作实际经过统一授权和恢复路径。

分发测试实际将 SDK 打包、在仓外离线安装，以 `lib: ["ES2022"]` / `types: []` 编译执行插件，调用其注册工厂，并验证原生取消、恢复查询和保留结果确认。这是 ABI 证据，尚不表示 Worker 已按安装包执行，或供应商副作用与生产恢复已接通。

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

CrewON 的主题投影读取已经绘制的原界面变量，不修改宿主样式。除原色彩、基础字体、控件高度及 `--radius-md`/`--radius-lg` 外，当前公共投影还包含 `--accent-ink`/`--accent-strong`、`--control-fg`/`--control-fg-muted`、`--control-ring`/`--control-ring-strong`、`--control-surface`/`--control-surface-active`/`--control-surface-hover`、`--panel-subtle`、`--radius-sm`/`--radius-xl`、`--shadow-modal`、`--space-1` 到 `--space-6` 和 `--user-code-font`。只提供实际存在的非空值；总计最多 39 个受支持名称，低于协议的 64 项上限。插件将它们应用到自己拥有的根节点，更新时清除已撤回的变量，卸载时释放局部节点；不能修改 `document` 的主题或复制全局工作区 CSS。

UI 服务只有 `services.invoke(action, input, { signal? })`，返回 JSON 值；动作必须由宿主映射并授权。接口没有客户端 actor、principal 或全局身份参数。实际挂载、主题传递、动作路由和 UI 隔离由宿主负责，SDK 中的类型和定义校验不代表页面已接通。

## 插件产物与宿主边界

以上是源文件示例。将 SDK helper 打包进插件产物，可避免安装目录需要额外解析 SDK 依赖：

```sh
pnpm exec esbuild src/node.ts src/ui.ts --bundle --format=esm --platform=neutral --target=es2022 --outdir=dist --out-extension:.js=.mjs
```

插件的 `crewon.plugin.json` 固定使用包协议 `crewon.plugin-package.v1`。入口相对路径必须指向产物，所有产物的真实字节长度和 SHA-256 必须列入 `files`；descriptor 自身不放入该 inventory。UI 入口还需声明对应贡献和合法 slot。完整包摘要由宿主核验实际目录后生成，不能用示例摘要代替。SDK 不是插件打包器、安装器或加载器，单独编译源文件不等于包已通过安装核验。

Node 插件运行在受信任的宿主进程中。公开 ABI 不是沙箱，也不提供文件系统、网络或权限隔离；安装信任、启停授权以及每次业务调用的身份检查由宿主负责。

任务和执行工厂 ABI 之外，当前 SDK 没有工作流调度、配置管理或计费服务端口。`services.get` / `provide` 只能访问宿主实际装配、且包中声明的命名服务，不意味着这些能力已经可用。
