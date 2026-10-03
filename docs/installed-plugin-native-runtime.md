# Native 安装包发布与 Worker 加载

此阶段接通 Electron Main 已明确开启的安装包发布与 Worker 加载。原用户栏、设置导航、页面组件和样式保持不变。没有固定开启文件时继续原默认或旧扩展路径；无模型时仍只提供本机安装和配置管理。

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

`workerConfigurationPath` 使用已有的 `crewon.installed-plugin-worker.v1` 私有协议，详见[服务启动](./installed-plugin-service-startup.md)。它包含真实安装目录、完整发布文档、HTTPS actor/policy/profile/package authority、可选的明确 network authority 和凭据环境变量引用。专用凭据变量可以使用 `NATIVE_INSTALLED_AUTHORITY_TOKEN`；不能引用默认 Control、模型或系统运行必需的变量。Main 将这些凭据仅交给 release/Worker 子进程。

发布文档仍为既有 `crewon.installed-plugin-release.v1`。它必须使用同一 Native profile、实际批准的包身份、安装副本和已持久化的业务配置；模型来源必须是独立 `directResponses` binding，匹配当前真实模型与凭据引用。默认 Agent 的 shared 工具绑定不作为插件来源。此阶段需要操作者预先构造完整文档，尚未自动从设置保存的配置和模型编译发布输入。

## 原运行链路

Main 捕获实际文件、profile、批准集合和模型绑定，再运行既有 `runtime-release`。release 使用同一个 `control.sqlite`，通过原发布授权及事务发布完整 default/source/derived bundle；Worker 从同一个库验证实际资产、部署、配置和包字节。原默认 Agent、模型目录与已有工具路径保留。

Main 随后启动既有 Worker，从实际输出读取新私有 peer 的 loopback origin，并使用本次启动随机 token 发起 `installed-plugin-peer.v1` catalog 请求。完整 principal/actor/tenant/space、profile 和 requestId 必须回显一致；每个返回的包、配置和完整执行目标必须属于准备的文档。停用业务包可以返回空目录，它证明管理请求及已发布元数据可加载，不证明 Node、IO 或供应商已经就绪。核验通过后才启动原 Control。

当前 Control 不获得 installed peer 凭据、任务准入或付款身份。Native 管理许可不能替代执行许可。本次启动不隐式启用业务包、不创建收费 Run、不注入余额或报价，也不发送生成请求。安装管理中的显式模块启用继续沿用原依赖规则；声明可选执行服务的模块可以启用，但这不证明业务可执行。与旧扩展同时开启同一个 Worker 时明确拒绝。

交付来源离线后继续使用已安装副本。取消、失败、停止和重启会先撤回新工作，再等待实际 release/Worker/Control 的 `close`，包括输出管道关闭；不能只凭 `exitCode` 删除仍被子进程消费的 bootstrap。退出未知时保留所有者，拒绝开启下一次运行。操作者配置和发布文件不作为临时文件删除。

## 本阶段验收

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

## 后续交付

下一阶段仍需从原设置的实际配置与模型自动准备发布输入，再完成 Native 候选激活、真实 Node/IO readiness、独立用户执行身份、个人积分准入与结算。正式 packaged App 执行、ComfyUI 在线生成、短剧持久项目和第二个真实企业 API 也在原目标范围内。
