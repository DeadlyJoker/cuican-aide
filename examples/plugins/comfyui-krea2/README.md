# Krea2 ComfyUI 插件

本目录是一个使用公开 `@crewon/plugin-sdk` 的独立包项目，包含 Node 动作服务、执行工厂、UI 模块和业务声明。构建产物可复制到宿主安装目录；执行时无需本仓源码、开发目录或 `node_modules`。

使用 Node.js 24、pnpm 10.33.0，在独立目录安装 SDK 后运行 `pnpm build`。`CREWON_EXAMPLE_PLUGIN_VERSION` 可指定包版本，默认 `1.0.0`。产物位于 `dist/<version>`，包括完整文件摘要的 `crewon.plugin.json`、业务声明、Node/UI bundle 和 SDK 许可文件。此项目仅依赖公开 SDK 与 Node 标准库。

构建后运行 `pnpm test` 可检查 bundle 的业务行为；也可以设置 `CREWON_TEST_KREA_PLUGIN_DIR` 指向已安装构建目录。该测试的 IO 是明确的单元测试端口，不能作为宿主授权、独立积分、真实数据库或生产网络策略已接通的证明。

宿主配置为 `{ "baseUrl": "https://approved-comfyui.example/" }`，不含凭据。地址必须是无用户信息、查询或片段的 HTTPS 根地址。宿主负责当前用户权限、个人独立积分报价和预留、固定服务地址的 DNS 与网络策略、请求限额、持久外部操作，以及原任务系统的运行和回执。执行工厂需要宿主提供 `PluginExecutionServices` 的 `externalOperations`、`jsonHttp` 和真实审批模式；缺失时明确拒绝执行。插件不会自行打开数据库或发起直接网络请求。

UI 贡献为 `studio`，提供 `image.generate` 和 `image.query`。宿主通过 UI 数据投影传入 `threadId`、`expectedThreadRevision`，可传入 `idempotencyKey`、`input.prompt`。查询另外需要投影真实 `sourceRunId`、`operationId`，可提供独立 `queryIdempotencyKey`。查询仅传源引用给 `crewon.tasks@2`，宿主从持久原任务解析原包版本、配置、目标和当前权限。每个按钮保存一次幂等请求，未知受理结果重试同一请求。

执行工具保留 `crewon_comfyui_krea2__submit`、`crewon_comfyui_krea2__observe`。提交前先持久预留，只有 `created` 加一次性调度凭证才允许 `POST /prompt`；已存在操作、恢复和查询均只读取。ComfyUI 的 `prompt_id` 是关联标识，不是服务端去重保证。超时、断线或查无历史都不允许重新提交。查询读取 `/history/<id>`、必要时读取 `/queue`，只采信输出节点 `29` 的真实结果。图片结果仅包含经过校验的 `/view` 引用，不下载图片。取消不会调用全局 `/interrupt`。

工作流保留现有已验证的单张 1MP、9:16 配置、固定模型与种子；仅提示词和操作的文件名前缀变化。原上传工作流为 4MP，未将该差异作为升级成本隐含改变。未连接的 LoRA 节点仍未连接，来源记录见 `provenance.json`。默认既有宿主 ComfyUI v0 实现及其摘要不由此包替换。

本地回执最多保留 32 项，完整 ACK 后单项释放；扫描独立轮转。ACK 只清理本地证据，不删除持久外部操作。退休必须满足无物理请求且无未 ACK 回执；显式关闭等待实际请求结束。构建与安装通过不表示用户的远程 ComfyUI 服务当前可用，真实服务的图生成需要单独验证。
