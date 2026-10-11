# Desktop Native 原图执行的显式启用

本轮把真实 Native TaskCore 发任务与 Worker 原图执行接到同一份部署声明。它是源码层的可选能力；正式桌面 0.1.70 和 Web 5730 的现有验收基线没有因此更新，也没有安装业务插件。

## 私有配置与兼容范围

只有 `crewon.desktop-plugin-bootstrap.v3` 可以带下面的可选字段：

```json
{
  "pluginComposition": {
    "version": "crewon.desktop-plugin-composition.v1"
  }
}
```

这个字段只声明部署已提供原图执行能力，不授予账号、插件、发布者或任务权限。Control 与 Worker 读取 Main 持有的真实 Native 配置、私有 authority 文件及其中绑定的 bootstrap 文件；原有路径、字节摘要和文件身份校验继续生效。禁止修改旧 bootstrap 后沿用旧摘要。变更部署应由真实 Host 创建新文件并重新绑定授权。

旧 v1、v2 和不带字段的 v3 配置继续走原来的解析、任务绑定和执行路径，不自动开启原图执行。v1、v2 带该字段会被拒绝。声明中多余字段、访问器、错误版本会被拒绝。

**旧版本的严格 v3 reader 也会拒绝这个新增字段。** 不能先给旧进程写带字段的配置再期待它忽略：Main、Control、Worker 必须一起升级到支持该声明的版本，然后显式启用。这里没有更新旧配置文件，没有改变公开 HTTP、Run、任务 admission 或 composition lock 的持久形状。开启后复用已有 `crewon.extension-run-binding.v1` 原图引用及 `crewon.plugin-task-admission.v1`。

## 原任务图与当前权限

Control 的 composition policy 来自同一 Native authority 的真实 scope 和 authority epoch，并在使用时复核。Worker 从同一份声明启用已有 composition executor，使用真实 `PLUGIN_EXECUTION_REGISTRY_COMPOSITION_SERVICE` 元数据；没有硬编码推测项目或媒体服务的 implementation revision。

Worker 读取任务保存的完整原图，不用当前安装列表替换旧 Run 引用。每次 `submit` 都由 Host 捕获的同步授权回调复核原图的 tenant、space、profile、authority epoch，异步权限读取前后及服务发布、消费末端再次检查。回调属于真实部署依赖，不接受 Run、HTTP 请求或插件自报的身份。新授权 epoch 不能给旧任务重新授予写入权限；同 epoch 的正常恢复可以继续。

`observe` 保留原任务图与结果读取能力，也必须通过现有 Native 文件校验、原账号解析、Run 访问策略、插件查询权限及原包审批。它同样调用真实 owner 的同步授权回调，在异步读取末端和 publication 前复核 owner 是否存活、Native 文件 pin 是否仍有效，以及 tenant、space、profile 是否与原图一致；仅允许 authority epoch 不同。允许观察旧 epoch 不代表允许再次执行：从观察 lease 发起 `execute` 仍按 `submit` 校验。Native 文件失效或账号、插件权限被撤回后，执行和观察都不能沿用旧批准。

已有项目、媒体 Node 服务尚无对应真实版本化元数据时，原图执行仍明确拒绝，不能把 UI 可用性或自报 revision 当成 Node 实现。未开启 composition 的基础启动保持原行为。

## 实际验证与尚未接通的部分

集成测试使用真实安装包字节、批准来源、SQLite、Native 授权文件、TaskCore、Agent 编译产物和 Worker。B 的实际 Worker 工厂捕获 A 的真实服务，执行产物通过原工具通道保存；关闭 owner、清空内存结果缓存、禁用 A 后，再打开 Control 与 Worker 可以按原图读取文件中的原执行回执。测试同时覆盖有效新 bootstrap 下的 epoch 换代拒绝、同 epoch 恢复，以及实际 provider 的最后一次异步账号读取结束后 bootstrap pin 失效时拒绝返回观察结果。

测试中的模型传输和 peer readiness 是明确命名的离线替身，A/B 是测试包，外部结果回执是测试文件。以上不等于线上模型、远端 peer 或业务供应商 API 验收。

**UI 发任务时的必需跨插件服务装配尚未闭环。** 当前 `InstalledPluginTaskActionOwner` 仍拥有单包 NodeHost 与真实的 per-mount `tasks` bridge，没有从原图借用已装配 provider 的生命周期与 ABI。本轮 B 的声明把 A 和 execution 服务设为可选，以兼容这个实际边界；Worker 工厂仍在真实装配时要求 A。这个测试证明原图发任务和真实 Worker 调用 A→B，不能证明必需 A 的 UI task action 已接通。下一步需要明确 task action 的实例 owner 和受控借用路径，继续保留原有任务审批与缺服务拒绝。
