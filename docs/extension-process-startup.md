# 插件进程接入与启动顺序

日期：2026-10-02。本文说明已经接线的发布 CLI、Worker、Control、开发服务器和原生桌面 standalone 入口。短剧工作台页面仍按[参考结论](./short-drama-workbench-reference.md)后置；执行继续复用现有 AgentVersion / Run / Tool。

当前环境变量接入用于显式单用户 standalone，SQLite 和 PostgreSQL 复用原有数据库参数。原生桌面也沿用现有单用户 standalone 装配，通过专用配置显式启用。production 拒绝通过环境变量启用插件，Worker 继续拒绝将 standalone 插件身份混入 native workspace bootstrap；生产当前身份查询服务及其协议仍需接通。

## 入口配置

所有入口只接受 `CREWON_EXTENSIONS_ENABLED=1` 启用；未设置或 `0` 保留原默认行为，其他值拒绝。启用 Worker / Control 必须明确提供 `CREWON_PRINCIPAL_ID`、`CREWON_ACTOR_ID`、`CREWON_TENANT_ID`、`CREWON_SPACE_ID`，不能依靠原有 standalone 默认值推导插件身份。

| 入口              | 参数                                         | 含义                                                              |
| ----------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| Worker            | `CREWON_EXTENSION_HOST_PORT`                 | private loopback 宿主端口；范围 0–65535，0 由系统分配             |
| Worker / Control  | `CREWON_EXTENSION_HOST_TOKEN`                | 同一 private peer token；至少 32 字节，不能包含空白或控制字符     |
| Worker / Control  | `CREWON_EXTENSION_HOST_DEADLINE_MS`          | 可选，1000–30000 毫秒                                             |
| Control           | `CREWON_EXTENSION_HOST_ORIGIN`               | Worker 的确切 `http://127.0.0.1:<port>` 地址                      |
| 发布 CLI / Worker | `CREWON_EXTENSION_RUNTIME_BINDINGS_PATH`     | 独立插件绑定文件，必须与下一项一起配置                            |
| 发布 CLI / Worker | `CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH` | 独立插件 AgentVersion 资产文件                                    |
| Worker            | `CREWON_EXTENSION_EXECUTION_MODE`            | 可选 `current` / `historical`；后者必须启用宿主并提供成对插件文件 |

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

新任务绑定精确配置、代码实现及 AgentVersion。普通停用插件后，保留宿主和相同构建即可恢复获授权的旧任务或查询；关闭整个插件宿主后，不承诺旧插件任务继续执行。启用插件宿主的 Worker 只领取同租户、同实际注册实现的插件任务；`current` 同时领取原普通任务，`historical` 排除全部未绑定插件的任务。两者均不能领取绑定其他实现的任务，也不把这些任务改为失败。此筛选发生在 pending / expired 候选分支的 LIMIT 之前，不替代实际调用的当前授权检查。

正式进程行为测试见 `apps/control-api/src/extension-process-flow.integration.test.ts`：实际子进程完成目录保存、不可提前激活、补充文件发布与保护、重启、激活、任务准入、SSE 重连及默认 Agent 对照。本地模型夹具不发起生图；真实 ComfyUI 调用及受理后恢复的独立证据见[实施进度](./incremental-extension-progress.md)。

## 原生桌面配置

`RuntimeSupervisor` 在每次启动和重启时读取原生数据目录中的 `desktop-extension-runtime.json`。文件不存在或明确关闭时保留原启动顺序。文件只接受下列三种完整形状，不能写入 owner、私有 token 或默认 Agent 设置：

```json
{
  "schemaVersion": "crewon.desktop-extension-runtime.v0",
  "enabled": false
}
```

首次保存配置使用目录宿主：

```json
{
  "schemaVersion": "crewon.desktop-extension-runtime.v0",
  "enabled": true,
  "runtimeBindingsPath": null,
  "agentVersionAssetsPath": null
}
```

发布插件后，将两个 `null` 同时换成已准备的补充文件绝对路径，再重启。部分路径、未知字段、超过 16KiB、非普通文件、文件符号链接或无效 UTF-8 均拒绝。

owner 固定为原桌面 standalone 的完整四字段：`standalone-principal`、`standalone-actor`、`standalone-tenant`、`standalone-space`。环境中的插件开关、peer、执行模式及 native bootstrap 不能覆盖该配置。每次启动重新生成私有 token，先执行原 release，再启动 Worker；读取实际 loopback origin 后以 token 发起有界目录挑战，验证完整 owner，再启动 Control。私有 peer 不进入 Renderer 的会话凭据。取消、宿主超时或进程退出均终止已启动子进程；终止失败时继续保留进程所有权，不能假装已清理后启动重复进程。

此路径验证了真实 release / Worker / Control 子进程和 SSE，并沿用当前桌面 standalone 身份。它不是生产多用户身份服务或 native workspace bootstrap 的插件支持。

## 构建保留与人工恢复

打包版桌面显式启用插件时，仅 release 收到原生数据目录 `CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT`。已加载的 `runtime-release.mjs` 先验证自身构建身份，再在发布和打开业务数据库前保留完整运行包。源代码开发模式、默认关闭、Worker 和 Control 不接收这个参数。

`dataRoot/extension-builds/<构建摘要hex>-<整套文件身份摘要hex>` 保留 sidecar 声明的全部 `.mjs`；不复制插件配置、模型绑定、凭据或其他文件。先写入私有临时文件，再以不覆盖已有文件的方式发布，最后以 sidecar 作为完整标记。每次选择都核对两层摘要及所有包字节；残缺目录、篡改、同实现不同文件集、遗留发布锁和超过 64 个保留构建均明确拒绝，不自动删除历史构建。构建完整性不能授予发布者或任务执行权限。

这里的构建摘要是 `getComfyImplementationDigest()` 对实际源码和依赖的指纹；任务配置中的插件实现摘要则组合了 manifest 与 adapter 指纹。两个摘要用途不同，不能互相替代。

人工恢复入口为 `scripts/retained-extension-worker.ts`。在提供完整当前 owner、数据库、原 Agent 路由、当前模型凭据、原不可变插件补充文件、宿主端口和私有 token 的环境中，明确选择先前保留的两个摘要：

```bash
CREWON_EXTENSIONS_ENABLED=1 \
  node --experimental-strip-types scripts/retained-extension-worker.ts \
  --data-root /absolute/native-data \
  --implementation-digest sha256:<构建摘要hex> \
  --build-identity-digest sha256:<整套文件身份摘要hex>
```

入口重新校验整套归档，只启动该归档中的 `runtime-worker.mjs`，固定使用 `historical`，不执行 release、不覆盖默认 Agent、不接收任意 Worker 路径。它在前台监督子进程并转发取消。Worker 仍需验证旧配置、版本、部署、当前授权及所需模型凭据；保留代码不能补齐丢失的配置或已撤销权限。

本轮 stage 输出 `crewon.extension-build-identity.v1`，其中 `historicalWorkItemScope` 必须为 `crewon.extension-work-item-scope.v0`，声明对应 Worker 支持历史任务范围。v0 包继续支持完整性验证和保留，但人工恢复入口拒绝启动：旧 Worker 可能忽略新增环境字段并领取普通任务。该能力标记也属于明确选择的整套文件身份摘要，不接受缺失、未知标记或自动降级。

当前尚无自动旧宿主编排及跨构建目录/就绪状态路由。新 Control 的当前宿主不能代替旧实现完成新查询准入；需要旧实现的查询仍须接到匹配宿主。源代码变更也不会自动产生可保留的运行包。因此，构建保留、明确历史领取和人工启动已交付，不能据此声称桌面自动升级恢复的整个产品流程已完成。
