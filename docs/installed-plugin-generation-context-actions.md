# 已安装插件的项目生成上下文

日期：2026-10-04。状态：就绪检查、原会话准备、模块重开后的请求恢复及独立短剧 5.0.0 生成控件已接通并分层验证。原操作查询、确切图片选用、完整应用重启后的未知结果恢复及正式个人结算仍待完成。

本阶段沿用[项目生成动作](./project-generation-ui-protocol.md)及[只读生成历史](./project-generation-read-ui-protocol.md)。插件只增加一个模块；原 App、用户栏、设置入口、两侧栏和共享样式没有在本阶段修改。普通 `crewon.tasks` 动作及其控件继续使用原接线。

## 就绪检查

新增独立服务 `crewon.project-generation-contexts@1`，唯一动作 `crewon.project-generation-contexts.v1.getReadiness`。SDK 通过 `createPluginProjectGenerationContextClient(services).getReadiness(input, options?)` 调用原 UI action transport，不创建会话、不提交 Run、不激活配置、不预留积分，也不自动重试。

请求严格包含 `reference`，其中保存输入引用为 `projectId`、`assetId`、`assetRevision`、`expectedProjectRevision`、`expectedAssetMetadataRevision`。响应回显原引用，并返回 `readiness`：

| outcome       | 附加字段                                                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`       | 无                                                                                                                                                 |
| `unavailable` | `reasonCode` 为 `project_generation_input_unavailable`、`project_generation_configuration_unavailable` 或 `project_generation_runtime_unavailable` |

请求和完整 JSON 响应各限 24 KiB，拒绝未知字段及引用不一致。身份、安装 pin 或策略拒绝仍是原动作错误，不能降级为普通不可用状态。就绪是当前交互提示，不是权限或余额承诺；提交时仍重新核验完整准入。

实际 owner 使用已配对的原 Task Application、issuer 和明确 source→target 发布映射；核验本人保存来源及 CAS、配置、执行能力、两端真实安装 pin、当前 profile/PDP 和连接。没有 generation owner 时，已知协议的 optional 依赖允许只读模块安装，但不发布可调用服务；required 依赖仍要求实际 owner 可用。未知版本继续拒绝。

## 原会话与请求恢复

模块宿主为声明生成及上下文协议的包提供可选 `data.projectGenerationContext`，版本为 `crewon.project-generation-host-context.v1`，完整 JSON 限 24 KiB。它包含 `phase`、`thread`、`threadReady` 和可空 `intent`；不包含账号、付款人、执行目标、价格或凭据。

`thread` 仅含原会话的 `threadId`、认证读取的 `revision` 和 `provisional`。打开模块只读取；用户显式创建会话才调用原 `createThread`。账户范围的所有者保留原 `{ title: null }` 请求与幂等键，未知结果重试不换键，关闭模块后仍观察已发送请求的真实晚回执。

`intent` 保留完整原项目生成请求、`pending / uncertain / accepted / refused` 状态、`retryable` 和原六字段受理回执。Web 与 Native 共用账户范围 journal：最多 32 项、16 个实际动作请求；真实请求结束前不释放物理槽，未确认意图不被淘汰。同 family 有未确认意图时，新键或新输入被拒绝，原输入、线程 CAS 与键保持不变。

只有宿主确认未发送的失败可标记 `refused`。凡已发送后的 HTTP、解析或超时失败均保留 `uncertain`；关闭页面或取消等待不表示供应商取消、退款或没有 COMMIT。明确重试仅允许实际请求已结束且当前完整 source pin 匹配的原意图。接受的真实回执保持接受状态。账号变更同步撤回；模块关闭、重开及同账号 runtime 重连保留原意图。

点击“打开生成任务”先通过保存来源读取原关联，核对受理回执对应的 Run、thread 和 configuration revision，再调用当前原 runtime 的 `adoptExtensionTask`。不按业务包 pluginId 查询另一个执行包的任务，不另建 Run 或 SSE 路径。读取或 adopt 期间的账号、模块或 runtime 变更禁止迟到导航。

## 独立短剧包

短剧 5.0.0 继续使用 metadata 项目保存，生成历史、生成和上下文能力是独立 optional 依赖。已保存输入才能生成；未确认请求冻结原输入与修订，禁止切换、归档或换键提交。关闭后重新挂载可根据宿主原意图恢复确切保存来源。暂时不可读或主题变化不丢失未知结果。

已有生成的同一输入版本不能重新生成，用户需保存新修订；返回空历史不证明原请求未提交。页面受理状态不表示供应商图片生成完成。图片仍使用只读历史的已验证引用，本阶段没有增加结果选用协议。

仓外消费者从实际 SDK tarball 构建，移除开发源码及依赖后运行发布 ESM。安装产物位于 `output/extensions/installable-plugins/generation-ui-short-drama-20261004/short-drama/5.0.0`；构建事实见 `output/extensions/checks/short-drama-generation-ui-artifact-20261004.json`，旧 4.0.0 产物保留。

## 验证范围

Contracts 318/318、SDK 40/40、Application 90/90、Host 66/66、Control 89/89 均零跳过。Control 包含实际 SQLite、单连接 PostgreSQL、安装包与 TLS HTTP 就绪检查，以及原付费提交回归。独立发布 ESM 44/44，原工作台组件 10/10；通用 journal/transport、会话 hook/控件及模块接线分别有专项回归。相关包类型、UI lint/build 和边界检查通过。各组存在重叠，不汇总相加。

这些测试使用明确 fixture 身份、积分和具名服务，不代表用户生产账号、真实钱包或在线 ComfyUI 验收。当前 5.0.0 的发布 ESM 与实际付费 HTTP/SQL 尚未作为同一次完整 App 生成链联合验收。journal 是账户范围内存恢复，不承诺应用进程重启后的 UNKNOWN 持久恢复。原操作查询、确切结果选用、正式 Main/packaged App 在线生成、个人价格结算及第二个真实企业 API 仍属于完整目标。
