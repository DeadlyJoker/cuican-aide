# 独立专业报告插件示例

将整个目录复制到 CrewON 仓库外开发，仅依赖公开 `@crewon/plugin-sdk`。它包含同一个包的页面、任务动作和执行工厂；不导入宿主源码，不修改首页或主题。示例不是已接通的企业 AI 服务，外部报告 API 必须由开发者实现或适配。

SDK 尚未发布到 registry。在 CrewON 仓库内用 Node.js 24、pnpm 10.33.0 执行 `pnpm --filter @crewon/plugin-sdk pack --pack-destination /absolute/sdk-output`，然后在复制后的插件项目中执行；模板的 `packageManager` 同样固定为 pnpm 10.33.0：

```sh
pnpm add /absolute/sdk-output/crewon-plugin-sdk-0.1.0.tgz
pnpm install
pnpm build
```

产物目录是 `dist/1.0.0/`，可交给 CrewON 的预构建目录安装端口。开发工具只用于仓外构建；安装器不运行脚本。升级时设置 `CREWON_EXAMPLE_PLUGIN_VERSION=2.0.0 pnpm build`，获得独立的新版本目录。模板使用现有 Node、TypeScript 和 esbuild，不属于第二套宿主运行时。

包将任务和执行服务声明为 optional：Control 动作宿主提供真实任务端口，Worker 提供真实执行工厂注册端口。只有宿主实际提供的服务才启用；缺任务端口时动作明确拒绝，缺执行工厂时 Worker 就绪检查拒绝。旧宿主缺少 `services.getOptional` 时整个包明确拒绝加载。

宿主配置必须提供 `organization`、`providerBaseUrl` 和真实报价/账户权限。页面投影必须来自原任务系统，包含已有 `threadId` 与 `expectedThreadRevision`；插件不能制造用户、付款方、价格或授权。每次挂载只创建一个报告任务；未确认时重试同一个冻结请求和幂等键。完整产品的任务导航、结果、充值与安装管理仍由宿主负责。

外部 API 契约：

- `POST /reports` 接收 `{ executionId, subject, organization, pluginVersion }`。服务必须将执行 ID 和结果持久化，并拒绝同 ID 的冲突输入。
- 成功返回 `{ status: "succeeded", executionId, report, pluginVersion }`；`report` 最长 8000 字符。
- `GET /reports/<executionId>` 查询同一已提交结果；查不到返回 `{ status: "unknownOutcome", executionId }`，不能据此重新提交。
- `DELETE /reports/<executionId>` 处理取消。此最小示例只理解原成功结果或 `unknownOutcome`；未知取消状态保留不确定性，不能假称撤销。

运行时按执行身份保留最多 32 份未确认结果，支持宿主有界扫描和完整回执确认；工具批次中的下一次调用不会覆盖前一次结果。满容量时明确拒绝新执行，正确 ACK 后可继续。相同执行已成功则返回原结果，不再次 POST；原结果不确定时只允许查询或取消。HTTP 错误响应取消实际 body，所有请求结束都撤销本次传输控制器。

HTTPS 是正常服务配置；`http://127.0.0.1` 仅供明确的本机验收供应商夹具。响应限制为 40KB、请求最长 30 秒、不跟随重定向。此代码运行在可信 Node 模式，继承该进程权限，URL 检查不是网络沙箱或 DNS 固定策略；未知第三方插件不能用这个模式获得隔离保证。ComfyUI 的原有安全传输和 v0 历史恢复不会被这个报告示例替换。
