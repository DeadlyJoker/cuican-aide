# 已安装插件的服务启动

当前生产 Control 支持显式启用已安装插件的 UI 目录、挂载及资源读取。它复用生产请求身份和现有 Web/BFF 会话，不创建账号、profile、权限 epoch 或积分余额。未配置时保留原页面和路由。

## 部署配置

生产启动使用已有 `CREWON_CONTROL_SECURITY_MODE=production`、数据库及身份配置，再提供以下变量：

| 变量                                               | 内容                                                           |
| -------------------------------------------------- | -------------------------------------------------------------- |
| `CREWON_PLUGIN_UI_ENABLED`                         | 严格为 `1`；不配置或 `0` 关闭。关闭时不能残留其他插件 UI 配置  |
| `CREWON_PLUGIN_UI_INSTALL_ROOT`                    | 宿主拥有的绝对安装目录，包含已核验的不可变 `packages/<digest>` |
| `CREWON_PLUGIN_UI_PROFILE_AUTHORITY_URL` / `TOKEN` | 返回当前用户所属 profile 的 HTTPS 服务及服务凭据               |
| `CREWON_PLUGIN_UI_POLICY_AUTHORITY_URL` / `TOKEN`  | 返回当前插件 UI 权限和稳定撤销 epoch 的 HTTPS 服务及服务凭据   |
| `CREWON_PLUGIN_UI_PUBLICATIONS_JSON`               | 宿主批准的包身份及 UI 文件子集，不自动公开 Node 文件           |
| `CREWON_PLUGIN_UI_AUTHORITY_TIMEOUT_MS`            | 可选；默认 2 秒，范围 1–30000 毫秒                             |

发布批准项包含完整 `packageDigest`、`pluginId`、`publisherId` 和 `publicAssets` 数组。所有路径必须属于对应安装包清单，且包含实际 UI 入口；批准项最多 32 个、每项最多 256 个文件，JSON 最多 128 KiB。配置中的摘要须来自实际包校验，不能填示例摘要来绕过身份核验。服务凭据通过部署秘密配置提供，不放进插件包、界面 props 或日志。

profile 服务接收服务端已验证的 `{ actor }`，返回 `{ tenantId, spaceId, profileId }`；租户和空间必须与当前 actor 一致。策略服务接收 `{ actor, action, resource }`，其中 action 为 `pluginUi:catalog`、`pluginUi:mount`、`pluginUi:asset` 或 `pluginUi:invoke`。允许返回 `{ outcome: "allow", authorityEpoch }`，拒绝返回 `{ outcome: "deny", reasonCode }`。epoch 由实际权限权威维护，同一权限域跨挂载、资源和动作保持稳定，并在撤销与重新授权时改变；不能使用请求 UUID 代替。

启动在共享 PostgreSQL pool 上显式迁移独立安装账本，不修改原任务、配置或积分 schema。只有部署批准且当前选择为 enabled 的包可以进入目录；每次请求重新核验身份、profile、包选择及权限。关闭服务会撤掉引用并取消尚未完成的权威请求。

## 执行边界

生产 main 尚未装配插件业务动作桥，动作明确返回 `plugin_ui_actions_unavailable`。服务端组合 API 可以接收真实 `PluginUiActionPort`，该端口必须进入原 Run、Tool、operation 和个人积分准入，不可直接从界面调用 ComfyUI。

PostgreSQL 安装账本另提供 profile owner：专用连接持有真实 session 锁，所有新安装写者遵守同一锁序；提交确认后才开放同步版本投影，旧回执不回退当前选择。拥有权不是权限，也不能瞬时证明尚未被客户端观察到的网络中断。Run 准入继续在自己的数据库事务内锁定实际选择行。

新内部 `createTaskFromPlugin` 路径通过原 Turn/Run 提交，显式 `migratePluginAdmissions()` 后，在同一事务保存独立包身份、profile、选择修订、调用者、权限 epoch、原 v0 binding 关联及真实个人报价。新生成缺少报价或存储准入能力时拒绝；已接受的重复请求返回原任务和原报价。v0 的摘要、回执和 HTTP 请求格式不变。此路径目前只支持生成；独立 SDK 的调用引用、业务动作桥、Worker 按包借用执行实例和历史查询接线仍待完成。

Web 资产通过现有同源 BFF 读取；Electron 的 `file://` 资产代理、生产安装管理、Krea2/短剧独立包和第二个真实企业 API 尚未交付。安装账本与 UI 读取的通过不能替代这些验收。
