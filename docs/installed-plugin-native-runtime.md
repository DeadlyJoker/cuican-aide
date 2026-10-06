# Native 安装包发布与 Worker 加载

Electron Main 已明确开启的安装包可以从已保存配置和当前模型自动准备发布输入，再沿用原发布与 Worker 加载。原用户栏、设置导航、页面组件和样式保持不变。没有固定开启文件时继续原默认或旧扩展路径；无模型时仍只提供本机安装和配置管理。

## 启动输入

Main 只从实际运行数据目录读取 `desktop-installed-plugin-runtime.json`，不从 Renderer 或环境变量取得开启意图。文件必须是当前用户拥有的私有普通文件，权限 `0600`、单硬链接、无符号链接且不超过 128 KiB。停用形状为：

```json
{
  "schemaVersion": "crewon.desktop-installed-plugin-runtime.v1",
  "enabled": false
}
```

开启形状如下，路径与模型值均须替换为实际输入：

```json
{
  "schemaVersion": "crewon.desktop-installed-plugin-runtime.v1",
  "enabled": true,
  "workerConfigurationPath": "/absolute/native-data/installed-worker.json",
  "providerBinding": {
    "providerId": "actual-provider-id",
    "endpoint": "https://actual-model-provider.example/v1",
    "responsesEndpoint": "https://actual-model-provider.example/v1/responses",
    "modelId": "actual-model-id",
    "credentialRequired": true
  }
}
```

`workerConfigurationPath` 使用已有的 `crewon.installed-plugin-worker.v1` 私有协议，详见[服务启动](./installed-plugin-service-startup.md)。它包含真实安装目录、完整发布文档、HTTPS actor/policy/profile/package authority、可选的明确 network authority 和凭据环境变量引用。专用凭据变量可以使用 `NATIVE_INSTALLED_AUTHORITY_TOKEN`；不能引用默认 Control、模型或系统运行必需的变量。v1/v2 的 Main 将这些凭据仅交给 release/Worker 子进程；v3 显式复用引用的范围见下节。

发布文档仍为既有 `crewon.installed-plugin-release.v1`。它必须使用同一 Native profile、实际批准的包身份、安装副本和已持久化的业务配置；模型来源必须是独立 `directResponses` binding，匹配当前真实模型与凭据引用。默认 Agent 的 shared 工具绑定不作为插件来源。v1 仍要求操作者预先构造完整文档，兼容原开启配置。

## 自动准备配置 v2

同一固定文件支持 `crewon.desktop-installed-plugin-runtime.v2`。`enabled: false` 仍只有版本和停用字段；开启时用实际插件列表和权限服务替代操作者的文档路径：

```json
{
  "schemaVersion": "crewon.desktop-installed-plugin-runtime.v2",
  "enabled": true,
  "providerBinding": {
    "providerId": "actual-provider-id",
    "endpoint": "https://actual-model-provider.example/v1",
    "responsesEndpoint": "https://actual-model-provider.example/v1/responses",
    "modelId": "actual-model-id",
    "credentialRequired": true
  },
  "plugins": [
    { "pluginId": "example.professional", "approvalRequirement": "none" }
  ],
  "workerAuthorities": {
    "actorAuthority": {
      "url": "https://actual-authority.example/actor",
      "serviceTokenEnvironmentVariable": "NATIVE_INSTALLED_AUTHORITY_TOKEN"
    },
    "policyAuthority": {
      "url": "https://actual-authority.example/policy",
      "serviceTokenEnvironmentVariable": "NATIVE_INSTALLED_AUTHORITY_TOKEN"
    },
    "profileAuthority": {
      "url": "https://actual-authority.example/profile",
      "serviceTokenEnvironmentVariable": "NATIVE_INSTALLED_AUTHORITY_TOKEN"
    },
    "packageAuthority": {
      "url": "https://actual-authority.example/package",
      "serviceTokenEnvironmentVariable": "NATIVE_INSTALLED_AUTHORITY_TOKEN"
    },
    "networkAuthority": null,
    "timeoutMs": 5000
  }
}
```

示例地址和凭据名必须替换为真实部署输入。列表限 1–32 个不同插件，每项 `approvalRequirement` 为 `none` 或 `perAction`。Main 捕获实际固定文件、批准包集合、持久 Native profile 和模型绑定；只在自有 `0700` 随机目录创建 `0600` 的 `preparation.json` 与 `worker.json`。Renderer 不能提交临时路径或自行签发这些输入。

原 `runtime-release` 首次以 `CREWON_INSTALLED_PLUGIN_NATIVE_PREPARATION_PATH` 模式运行：在分配默认工具前验证私有文件和环境，读取同一个 `control.sqlite` 的真实安装选择和最新业务配置，重新请求真实 actor/profile、包读取和策略许可，核验安装字节与业务 schema。Main 当前生成 `crewon.installed-plugin-native-preparation.v2` 输入，CLI 逐项输出私有 `preparation-result.json`，并仅在至少一项可准备时生成同目录的原 `release.json`。旧准备输入 v1 及其严格整组拒绝行为保持兼容。这一步不发布任何 Agent、不写 runtime bindings、不改变选择、不导入业务 Node。完整发布文档保持原 1 MiB 上限；较长合法模型定义和 32 项组合不会被通用扩展 JSON 的 64 KiB 序列化限制误拒绝。

Main 等待准备 CLI 的实际 `close`，重核全部所有者，再以原发布模式运行同一个 CLI。默认、独立模型 source 和插件 derived 资产在这一次发布中建立；不要求此前已启动或发布普通默认 Agent。source 使用当前模型的真实 binding、instructions/model/execution，独立清空默认工具和工作区依赖；配置修订、随机目录及凭据值不改变相同模型的 source 身份，配置或批准要求变化会改变 derived 目标。

保存配置继续只是保存。下一次明确启动或重启才读取最新 revision；没有隐式热重启或业务执行。显式列出的插件已卸载、未批准、缺少首配、配置不兼容、安装字节不可用或读取权限被撤回时，只阻止该插件准备。有效子集仍通过原 issued v1 发布、Worker 和私有 catalog 核验；全部受阻则不生成 release，清除 installed/task/peer 与本次捕获的专用权限凭据后启动原普通默认 Agent。固定私有文件、环境、身份、profile 或租户边界损坏仍拒绝整个启动，不能作为插件失效吞掉。v2 固定文件仍是明确操作者开启输入，尚不是用户安装后的完整自动执行闭环。

结果契约为 `crewon.installed-plugin-native-preparation-result.v1`，限制 128 KiB、1–32 项，按请求顺序逐项给出 `prepared` 或 `blocked`。prepared 含实际完整包 tuple、配置修订/摘要、批准要求及八字段目标；Main 与原发布文档逐项比较，不接受仅同名或同数量的结果。blocked 只含插件 ID 与固定原因枚举：`notInstalled`、`notApproved`、`configurationMissing`、`configurationIncompatible`、`packageUnavailable`、`readDenied`、`stateChanged`。准备 CLI 重核发现配置/选择竞争时，移除受影响候选并有界重建结果，不把已发现失效的候选输出为 prepared；这不承诺整个启动期间的原子 latest 或热更新。结果与可选发布文件均原子不覆盖写入，失败只能撤掉自身实际 inode；默认子进程也结束后才能清理本次准备所有者。

## 显式启用与业务激活 v3

固定开启文件新增 `crewon.desktop-installed-plugin-runtime.v3`，保留 v2 的全部开启字段，并要求独立的激活权限端口：

```json
{
  "activationAuthority": {
    "url": "https://actual-authority.example/activate",
    "serviceTokenEnvironmentVariable": "NATIVE_ACTIVATION_AUTHORITY_TOKEN"
  }
}
```

上面的片段须加入完整 v3 开启对象，不能单独作为配置。停用对象仍只含版本和 `enabled: false`。v1/v2 不接受该新字段，也不会自动获得激活权限。激活端口只接受 HTTPS；凭据仍为专用环境变量引用，不能引用系统、模型或 Control 运行必需的变量。

Main 沿用 v2 的准备和原发布流程，等待真实 Worker catalog 挑战和响应体结束，再从本次已核验的完整发布条目、实际 Worker loopback origin、Native actor/profile 与安装根签发私有 `crewon.desktop-installed-plugin-activation.v1` 输入。它只写入自有 `0700` 目录中的 `0600` 普通文件，并只向本次 Control 传递文件路径、私有 peer token 和激活权限凭据。独立的激活凭据不交给 Worker；若它与既有 Worker 权限引用相同，Worker 保留原本所需的引用。Renderer、健康响应和公共配置不能读取这些凭据。

私有输入限 1 MiB、1–32 条，固定八字段执行目标与完整六字段包身份；每项配置沿用 private peer 的 16 KiB 限制。协议只承载已发布业务元数据，不签发任务身份、付款身份、报价或供应商访问。Control 必须把输入绑定到实际 Native 注册表、批准集合、父 SQLite Store 和持有中的 profile owner；同形副本、不同实例和撤回的文件都不能接管该所有者。

原安装 HTTP 对含 businessManifest 的业务包执行新的显式 `enable` 时，先对仍为 disabled 的准确 selection revision 调用真实 Worker `prepareCandidate`，核验实际 Node 工厂借用和声明服务的 IO 就绪，再准备本地 Node。UI-only 包保持原启用路径，已有 selection receipt 的幂等重放不重新预检。激活权限端口每次收到完整 actor、`extension:activate` 及当前 tenant/space/plugin 的 extension resource；只接受严格 `allow` 或带明确原因的 `deny`。停用候选的预检与权限等待结束后再次检查实际选择、包、最新配置和完整部署，不把旧 ready 当作新权限。

本次 v3 业务模块启用的 selection 和 select receipt 写入之前，同步复核进入原 SQLite 事务，使用同一父连接核验当前 profile 所有权、selection/package、最新配置和部署。同步检查抛错会回滚；不会在事务内进行远程权限或网络等待。原幂等重放不再次调用该检查，回执也不保存函数。该检查是可选的内部端口，安装、停用、UI-only 启用及配置或 activation 保存保持各自原用例，不会自动获得新的业务复核。PostgreSQL 的通用 selection Store 同样提供事务内同步检查，但此处 Native 的实际所有者与就绪验收使用 SQLite，不宣称跨服务原子提交。

模块启用与业务 activation 仍是两次原操作。模块启用不写 activation；业务 activation 通过原 `PUT /api/v1/extensions/:pluginId/activation`、真实启用包的 readiness 和原 CAS/回执保存。目标不匹配或配置已经变化时拒绝旧请求；更新配置仍需明确重启后准备新目标。没有显式 v3 的 Native Control 继续原 metadata-only 许可，不借用私有 peer。

停止时先撤回新工作，再等待真实 HTTP/body、Worker/Control 和本地 Node 清理；所有消费者物理结束后才清理自有私有输入。清理须核对原文件字节和 inode、目录身份及准确子项；文件被改写或替换、目录出现未知子项时保留并报错，不递归删除。固定输入的变化由下一次所有者检查或重启检出，未提供文件监听或即时自动撤销。原固定开启文件不作为临时文件删除。此步骤不接通插件任务准入，不导入默认资金、不创建 Run，也不发送生成请求。

## 原运行链路

Main 捕获实际文件、profile、批准集合和模型绑定，再运行既有 `runtime-release`。release 使用同一个 `control.sqlite`，通过原发布授权及事务发布完整 default/source/derived bundle；Worker 从同一个库验证实际资产、部署、配置和包字节。原默认 Agent、模型目录与已有工具路径保留。

Main 随后启动既有 Worker，从实际输出读取新私有 peer 的 loopback origin，并使用本次启动随机 token 发起 `installed-plugin-peer.v1` catalog 请求。完整 principal/actor/tenant/space、profile 和 requestId 必须回显一致；每个返回的包、配置和完整执行目标必须属于准备的文档。停用业务包可以返回空目录，它证明管理请求及已发布元数据可加载，不证明 Node、IO 或供应商已经就绪。核验通过后才启动原 Control。

v1/v2 Control 不获得 installed peer 凭据；v3 仅获得上述显式启用和业务激活的私有端口。它们都不获得任务准入或付款身份。Native 管理许可不能替代执行许可。启动不隐式启用业务包、不创建收费 Run、不注入余额或报价，也不发送生成请求。安装管理中的显式模块启用继续沿用原依赖规则；必需而未实现的服务仍然拒绝，模块启用也不证明业务任务可执行。与旧扩展同时开启同一个 Worker 时明确拒绝。

交付来源离线后继续使用已安装副本。取消、失败、停止和重启会先撤回新工作，再等待实际 preparation/release/Worker/Control 的 `close`，包括输出管道关闭；不能只凭 `exitCode` 删除仍被子进程消费的 bootstrap。实际 private peer 的 HTTP/body 挑战也必须结束，才能清理临时准备目录和 bootstrap。退出未知时保留所有者，拒绝开启下一次运行。固定操作者配置和 v1 操作者发布文件不作为临时文件删除。

## v1 加载阶段验收

在 Node.js 24 下提供真实独立包目录，运行：

```bash
CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR=/absolute/independent/professional-package \
  pnpm --filter @crewon/ui exec vitest run \
  electron/desktopInstalledPluginRuntime.process.integration.test.ts \
  electron/desktopInstalledPluginRuntime.lifetime.integration.test.ts
```

最终日志 `output/extensions/checks/native-installed-runtime-process-final-20261003.log` 为 **3/3、零跳过**。实际 Native HTTP 安装保持停用，保存业务配置后，操作者文档经原 CLI 发布，Worker 完成真实 HTTPS 权限检查与私有 catalog 握手，原 Control 返回 ready。交付来源移走后，新 Supervisor 使用同一 SQLite 冷恢复；撤回包读取权限后，发布拒绝且不启动 Worker/Control、不修改原数据库事实。另一个测试保留无插件开启的普通 default 进程路径。

并发关停测试只暂停交付真实 private peer HTTP 返回的原 Response，没有替换请求、响应体或授权结果。被挑战的实际 Worker 已退出后，stop/restart 仍等待挑战结束，原 bootstrap 保留且没有替代子进程；释放 Response 后完成停止和实际 Control 重启。独立的真实 Node 子进程测试还覆盖 parent 已退出但后代持有 stdout 的情况，只有输出关闭才可撤掉所有权。

这三项使用实际 source Supervisor、Control/release/Worker 子进程与 SQLite，并使用具名 HTTPS 权限、模型和供应商测试服务。验收中业务 Node 导入、模型请求、供应商请求、Run 和资金记录为零。它们证明发布与加载准备，不是正式 Electron Main 开启插件、packaged App 或业务执行验收。完整默认 bundle 来自先前一次原默认启动，仍是本阶段操作者输入的前提。

固定配置/运行 owner/私有挑战检查 **85/85**，原默认/旧扩展/bootstrap/物理关闭回归 **69/69**，原 Native 配置行为 **18/18**，正式 Main/preload/file App 原用户栏、设置、安装和配置冷恢复专项 **2/2**，均零失败、零跳过。UI lint/build、Main 构建、七个 runtime bundle、boundary 和生产许可证检查通过。早期两次全量 UI 仍有旧失败，范围及完整日志见[实施进度](./incremental-extension-progress.md)；不能称全量 UI 通过。

## v2 自动准备阶段验收（隔离变更之前）

提供上述实际独立专业包，运行：

```bash
CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR=/absolute/independent/professional-package \
  pnpm --filter @crewon/ui exec vitest run \
  electron/desktopInstalledPluginRuntime.automatic.process.integration.test.ts \
  electron/desktopInstalledPluginRuntime.automatic.lifetime.integration.test.ts \
  electron/desktopInstalledPluginRuntime.automatic.preparation-lifetime.integration.test.ts \
  electron/desktopInstalledPluginRuntime.process.integration.test.ts \
  electron/desktopInstalledPluginRuntime.lifetime.integration.test.ts
```

冻结后的实际进程验收 **6/6、零跳过**，日志为 `native-installed-automatic-process-final-20261003.log`。通过原 Native HTTP 安装和保存配置，确认 Agent 表零行后直接启动 v2；两次真实 CLI 完成准备和首次完整发布，原 Control ready。来源离线时使用已安装副本恢复同一 bundle；配置 revision 2 在下次启动生成新 derived 并保留旧资产与部署，未声称已能执行历史查询。实际包权限撤回则无新发布、无 Worker/Control。v1 原加载和普通默认路径一并回归。

新增关停验收用自有 HTTPS proxy 转发并核验原 actor 响应，只延迟原字节。准备 CLI 仍等待时，实际 PID 存活、临时目录只有两份输入、bindings 不存在且发表表为零；停止返回时 CLI 已物理退出，随后文件清理，同一固定配置可以实际重新启动。另一项保留原 private peer Response 的验收证明 Worker 退出后仍必须等待挑战结束。

Worker 新准备及实际 CLI 前置拒绝 **16/16**，桌面配置/owner **79/79**，原默认/旧扩展/bootstrap/关闭及 peer 检查 **94/94**。原 Worker 文档/loader/bindings/CLI/publication 回归 **43 通过、5 个 PostgreSQL 跳过**；本轮未提供 PostgreSQL，不将跳过计为完成。具名测试权限服务和实际 SQLite 证明自动准备与发布，业务 Node、模型请求、供应商、Run 和资金记录均为零；不是生产权限、真实用户执行或付款验收。

正式 Main/preload/file App 原用户栏、设置导航、安装和业务配置冷恢复专项 **2/2、零跳过**，日志和截图位于 `native-installed-automatic-original-app-20261003` 前缀。本轮未修改 Renderer、全局 CSS 或旧快照；此专项没有开启 installed execution。UI lint/build、Worker/Control 类型、Main 构建、七入口 runtime stage、生产 license、boundary 和格式检查通过。合计 240 通过、5 个 PostgreSQL 跳过，范围及夹具实际清理记录见 `native-installed-automatic-proof-20261003.json`。

## v2 单插件隔离验收

提供两个真正独立保留的包，在 Node.js 24 下运行：

```bash
CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR=/absolute/independent/professional-package \
  CREWON_TEST_KREA_PLUGIN_DIR=/absolute/independent/krea2-package \
  pnpm --filter @crewon/ui exec vitest run \
  electron/desktopInstalledPluginRuntime.fault-isolation.process.integration.test.ts
```

实际 **7/7、零跳过**，日志 `native-installed-isolation-process-final-20261003.log`。HTTP 卸载、未首配和真实 HTTPS 撤回读取权限后，普通默认 Agent 都经真实模型请求、原 HTTP/SSE 与 SQLite completed Run 完成。有效 Krea2 与未首配专业包的混合情况只发布 Krea2，两个停用选择均保留。私有文件、actor 和 profile 损坏仍拒绝整个启动。插件 Node、供应商、task/admission/binding、外部操作和资金记录均为零；普通默认 Run 不是插件执行证明。

原自动/手工/普通默认与物理关停进程回归 **6/6**；Worker 准备/隔离/实际 CLI **37/37**，Contracts 全量 **237/237**，桌面配置和 owner **101/101**，原 Supervisor/旧扩展/bootstrap/关闭和 children **88/88**，正式 Main/preload/file App 原设置与管理 **2/2**，均零跳过。原 Worker 发布回归 **50 通过、9 个 PostgreSQL 跳过**；未提供 PostgreSQL。UI lint/build、Main、七入口 stage、类型、license、boundary 与格式检查通过。总计 528 通过、9 个 PostgreSQL 跳过，实际独立包摘要与物理清理记录见 `native-installed-isolation-proof-20261003.json`。

完整 Renderer、CSS 和旧快照未改；本次没有重跑全量 UI 或启动共享 SDK producer。上述测试权限/模型不代表生产权限或实际付款，正式 App 两项也没有开启插件业务执行。输入 v1 的严格拒绝保持兼容，v2 仍需要明确私有开启文件。

## 停用候选的真实 Node/IO 预检

Worker 私有 peer 现在提供独立 `prepareCandidate` 操作，接受实际完整包身份、当前首配、原发布目标和停用 selection 的准确修订。它沿用同一 SQLite、resolver、Node 容器和 IO owner，反复校验实际身份、profile、安装字节、权限、latest 配置与部署；成功需要实际借用注册 factory，并通过声明服务的原 IO 预检。原 catalog 和普通 readiness 仍只接受启用选择。协议和兼容边界见[任务启动说明](./installed-plugin-task-startup.md#disabled-candidate-preparation-on-the-private-peer)。

v1/v2 保持该操作的原后台基础范围；显式 v3 按上节接入原 enable 和 activation。预检本身不会启用、激活、调用业务 factory.create、创建 Run、扣积分或请求供应商；公共 IP 的真实 DNS 通过也不代表 ComfyUI 在线生成成功。后续业务执行仍须重新验证实时权限与状态，不能复用旧 ready 作为执行许可。

## 后续交付

下一阶段完成 Native 的独立用户执行身份、个人积分准入与结算。正式 Main/full App/packaged App 执行、ComfyUI 在线生成及历史查询、短剧持久项目和第二个真实企业 API 也在原目标范围内。v3 的实际验收结果与边界见[实施进度](./incremental-extension-progress.md)。

## 原对话的媒体输入准备

`crewon.desktop-project-execution.v1` 新增可选 `mediaInputStages`，版本为
`crewon.project-media-input-stages.v1`，包含确切 `pluginId/packageDigest/contributionId`
的 `publications`。每项必须已在 `conversations` 中声明，并存在同包的
`mediaInputs` 工作流审定；后者必须含 `read` 与 `write`。旧配置不推导此字段，
`mediaInputUi` 和媒体生成许可仍独立。历史配置 v1 继续拒绝此字段。

Main 的原 bootstrap 文件保留声明，Control API 在原父库准备阶段关系并绑定原
Thread 服务；Native Worker 将它转换成 `projectMediaInputs` 服务工厂，沿用该
Worker 实际借用的父库。阶段工具要求原 actor/profile、确切包版本、工作台贡献和
`project.execute`；只允许描述与参考素材的读取和修订，不提供 qualify、上传、生成
或采用权限。异步调用和事务提交核对同一个 Main 文件 owner，撤销后旧服务失效。

Control API 与 Worker 共用 `@crewon/artifacts` 的 ComfyUI 结果解码器，历史导出路径
保留兼容性；结果必须仍对应原配置、原 operation、成功状态及确切输出位置。

当前此项完成部署协议、原生装配和行为检查。Settings 的执行准备写入器尚未生成新声明，
正式桌面包的“Agent → 插件页 → Agent”接力尚待验收；不得将元数据夹具或具名模型测试
作为用户 App 已更新或真实生成成功的证明。
