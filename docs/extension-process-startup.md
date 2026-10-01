# 插件进程接入与启动顺序

日期：2026-10-01。本文说明已经接线的发布 CLI、Worker、Control 和开发服务器入口。短剧工作台页面仍按[参考结论](./short-drama-workbench-reference.md)后置；执行继续复用现有 AgentVersion / Run / Tool。

当前环境变量接入用于显式单用户 standalone，SQLite 和 PostgreSQL 复用原有数据库参数。生产多用户及原生桌面的可信身份接入、历史构建保留仍待实现；production 拒绝通过环境变量启用插件，Worker 也拒绝将 standalone 插件身份混入 native bootstrap。

## 入口配置

所有入口只接受 `CREWON_EXTENSIONS_ENABLED=1` 启用；未设置或 `0` 保留原默认行为，其他值拒绝。启用 Worker / Control 必须明确提供 `CREWON_PRINCIPAL_ID`、`CREWON_ACTOR_ID`、`CREWON_TENANT_ID`、`CREWON_SPACE_ID`，不能依靠原有 standalone 默认值推导插件身份。

| 入口              | 参数                                         | 含义                                                          |
| ----------------- | -------------------------------------------- | ------------------------------------------------------------- |
| Worker            | `CREWON_EXTENSION_HOST_PORT`                 | private loopback 宿主端口；范围 0–65535，0 由系统分配         |
| Worker / Control  | `CREWON_EXTENSION_HOST_TOKEN`                | 同一 private peer token；至少 32 字节，不能包含空白或控制字符 |
| Worker / Control  | `CREWON_EXTENSION_HOST_DEADLINE_MS`          | 可选，1000–30000 毫秒                                         |
| Control           | `CREWON_EXTENSION_HOST_ORIGIN`               | Worker 的确切 `http://127.0.0.1:<port>` 地址                  |
| 发布 CLI / Worker | `CREWON_EXTENSION_RUNTIME_BINDINGS_PATH`     | 独立插件绑定文件，必须与下一项一起配置                        |
| 发布 CLI / Worker | `CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH` | 独立插件 AgentVersion 资产文件                                |

未启用时，完整 peer 配置仍检查格式，但不启动宿主、不创建 Control 客户端、不注册插件路由。完整插件文件路径只检查成对及路径形状，不读取或发布插件。任何部分配置均拒绝。启用仅使宿主入口可用；具体插件是否启用，仍由空间内 activation 状态控制。

原 `CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH` 继续表达原有模型及 Agent 绑定。新增插件使用补充文件；发布 CLI 自动生成原文件时，先核对补充文件和合并结果，再写原文件。文件别名、符号链接及硬链接不能绕过插件输入保护。插件不得覆盖默认 Agent，也不得重复已有版本 ID。

## 两步接入

```mermaid
flowchart LR
  H[启动目录宿主] --> C[通过 Control 保存配置]
  C --> V[编译独立插件 AgentVersion]
  V --> P[现有 CLI 发布资产及部署]
  P --> W[Worker 装配精确版本]
  W --> A[通过 Control 启用插件]
  A --> T[任务准入与现有 SSE]
```

1. 使用现有参数发布默认 Agent。启用 Worker 的 private host，暂不设置两个插件文件路径；等 Worker 输出 `CrewON Extension Host origin ...` 后，再启动指向它的 Control。此时可以取得目录、校验并保存配置，未发布的插件版本仍返回 unavailable，不能提前激活。
2. 从明确的 crewonKernel AgentVersion 使用 `compileComfyAgentVersion` 编译独立版本。它保留原模型、工具和资源要求，追加 ComfyUI 指导及两个工具；不选择新的默认模型。将保存的配置修订、审批要求、该版本资产及确切模型绑定写入独立文件，再启用两个插件文件路径，通过原发布 CLI 发布。重启 Worker 后，Control 才能取得实际工厂的 ready 判定，启用插件并创建任务。

在已经提供所需原有模型、数据库、发布身份和插件路径参数的环境中，继续使用原命令：

```bash
CREWON_EXTENSIONS_ENABLED=1 pnpm --filter @crewon/runtime-worker release
CREWON_EXTENSIONS_ENABLED=1 pnpm --filter @crewon/runtime-worker start
CREWON_EXTENSIONS_ENABLED=1 pnpm --filter @crewon/control-api start
```

三个命令分别运行；先等 Worker 就绪，再启动 Control。CLI 不需要运行 private host，也不会自动编译插件或保存配置。插件文件应使用绝对路径，秘密值继续使用原有凭据机制，不能写入插件配置或资产。

补充资产文件使用 `{ schemaVersion: "crewon.extension-agent-version-assets.v0", assets: [...] }`，其中每个元素是原有 `AgentVersionAsset`。补充绑定使用原有 `crewon.agent-version-runtime-bindings.v0`，每项必须具有 `extensionConfigPath`，与资产按版本 ID 一一对应；最多 32 个版本。配置快照使用 `crewon.extension-runtime-config.v0`，冻结完整配置修订和 `none` / `perAction` 审批要求。未知字段、摘要不符、跨租户及执行主体不支持都会拒绝；实际 ready 还要构造并验证真实运行时。

## 开发服务器与恢复

`scripts/crewon-control-web-dev.mjs` 启用插件时先启动 Worker，按其输出的实际宿主 origin 等待就绪，再启动 Control；port 0 的实际地址会传给 Control，固定端口的已有确切地址必须相符。就绪超时或子进程失败会清理已启动的进程。当前显式限制为一个 Worker；未启用插件的原多 Worker 行为保持不变。

新任务绑定精确配置、代码实现及 AgentVersion。普通停用插件后，保留宿主和相同构建即可恢复获授权的旧任务或查询；关闭整个插件宿主后，不承诺旧插件任务继续执行。代码升级产生新实现身份，不能用新代码冒充旧任务的实现；历史构建保留和升级协调尚未交付。

正式进程行为测试见 `apps/control-api/src/extension-process-flow.integration.test.ts`：实际子进程完成目录保存、不可提前激活、补充文件发布与保护、重启、激活、任务准入、SSE 重连及默认 Agent 对照。本地模型夹具不发起生图；真实 ComfyUI 调用及受理后恢复的独立证据见[实施进度](./incremental-extension-progress.md)。
