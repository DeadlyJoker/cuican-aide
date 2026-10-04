# Native 安装插件任务执行接线

日期：2026-10-04。范围：独立私有执行配置、真实 Native factory、共享任务核心及 Standalone Main 的文件 opt-in 和 HTTP 任务读取；Electron 签发与完整短剧流程仍待接入。原 App、用户栏、设置、侧栏和共享样式保持原字节。Main 的最新验收见[启动接线](./native-installed-plugin-task-main.md)。

## 1. 当前行为

`createDesktopPluginRuntime` 增加可选 `tasks`。传入实际签发的独立执行配置后，借用同一 Native configuration/request/activation owner 和原 SQLite store，装配实际 Task Application、积分事务和安装任务 owner。普通 Node action 可以使用其声明的名称，例如 `image.generate`；执行仍经过实际安装包、当前 profile、身份、授权、报价、原 Turn/Run 和幂等事务。

不传 `tasks` 时保留原 metadata/history 路径，不创建任务核心，不获得生成、查询、报价或资金权限。原 activation 审批只负责启用和执行连接，不替代任务执行批准。工厂不创建钱包、发放积分、选择付款账户或设置默认价格。

工厂可接受可信程序装配的 `tasks`；实际 Standalone Main 和公开 Standalone creator 只接受真实私有文件签发的配置。Main 已通过实际进程、安装 Node/UI、HTTP、SQLite 和原键冷重放验证普通任务。它不代表 Electron challenge/bootstrap 或 Native 短剧联合验收。原 Standalone Main 的历史读取、图片选用和冷重启恢复继续有效。

## 2. 独立私有配置

纯契约为 `crewon.desktop-installed-plugin-tasks.v1`，最大 64 KiB，严格拒绝未知字段、访问器、异常原型和非有限数字。必需字段如下：

| 字段                            | 含义                                                           |
| ------------------------------- | -------------------------------------------------------------- |
| `schemaVersion`                 | 上述固定版本                                                   |
| `actor`、`scope`                | 与实际 Native 身份和空间一致                                   |
| `authorityEpoch`、`installRoot` | 与当前 bootstrap 一致                                          |
| `activationDigest`              | 已严格解析 activation publication 的 canonical JSON 的 SHA-256 |
| `uiPublications`                | 1–32 个精确 pluginId/packageDigest/contributionId，禁止重复    |
| `taskPolicyAuthority`           | 任务资源 PDP 的 HTTPS endpoint 和凭据环境变量引用              |
| `uiPolicyAuthority`             | 插件 UI 的独立 PDP endpoint 和凭据引用                         |
| `packageAuthority`              | 实际执行包批准 endpoint 和凭据引用                             |
| `quoteAuthority`                | 个人插件积分报价 endpoint 和凭据引用                           |
| `timeoutMs`、`maximumPackages`  | 有界超时和安装包数量                                           |

四类端口必须显式提供；可以由同一可信服务实现，不人为要求不同 URL 或 token。凭据由环境中的真实数据字段捕获，不写入 publication、日志或 JSON/inspect 输出。报价继续使用原协议和精确整数积分字符串。

文件 loader 使用 `CREWON_DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_PATH`，仅接受 Standalone，并要求明确 bootstrap 和 activation companion paths；没有 opt-in 时不读取其他路径或凭据。实际文件采用有界 fd 读取、`O_NOFOLLOW`、文件与祖先 pin 核验及私有叶文件/父目录权限，文件变化后失效。当前不支持 Windows。

程序解析结果与文件签发结果由不同私有 provenance 记录区分。Main 和 Standalone creator 调用 `assertDesktopInstalledPluginTaskConfigFileIssued`，不能把程序对象或浅复制当成可信文件。`activationDigest` 绑定解析后的 publication，排除运行时秘密；它不等于原文件字节摘要，也不替代独立的文件 pin 证据。loader 只验证 companion path，实际执行 owner 还要绑定已经加载的 Native 与 activation 实例。

## 3. 实际 owner 和权限

执行 owner 必须同时绑定实际 source registry、installation runtime、Native authority、configuration runtime、activation owner、SQLite store 和 request owner。configuration runtime 及执行配置使用私有签发记录；DTO 复制、混用实例或旧文件不能借用执行权限。

| 调用            | 当前检查                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| Task            | 原资源动作和 tenant/space/actor、当前实际请求、独立任务 PDP、调用前后 Native owner                   |
| UI mount/invoke | 实际 profile/source 字节、精确 UI tuple、独立 UI PDP；policy epoch 改变使旧 lease 失效               |
| Package         | 实际 registry approval、精确 descriptor/digest 和原包批准协议                                        |
| Quote           | 原 InstalledPluginCreditQuoteAuthority、原 principal/request、显式返回的 pool/price revision/credits |

目录的 scope-only 检查继续使用原 Native authority；执行 publication 对应的插件包使用独立 UI PDP，即使请求的 contribution 不匹配也不能回退到较宽的原审批。原 metadata/history 的批准不会自动变成任务批准。配置和启用动作不属于新的任务 PDP 资源集合。

新任务预留个人插件积分，重放返回原业务回执，不重复报价或预留。真实余额不足仍由原 SQLite credit 事务拒绝；测试中的明确个人测试账户、100 积分和 30 积分报价均不是生产资金或真实定价。

## 4. 生命周期与必需 Host 服务

关闭同步撤回 Native authority 和 deferred availability，然后等待实际 HTTP、profile、Node action、原 Application 和 SQLite 操作物理完成。迟到读取拒绝；实际事务已经 COMMIT 时保留原 opaque 成功回执。任务核心借用原 request owner/store，不能替父级关闭它们；外层 Native factory 关闭自己拥有的请求和安装 owner。

必需的生成、就绪和查询 Host 服务使用新 deferred composition seam，解决真实 core 只能在 installation/configuration owner 创建后装配的顺序依赖。它仅绑定一次实际端口，关闭后永久不可用；协议的私有 brand 沿实际 owner/capture 链判断，普通 `isAvailable: () => true`、复制对象、异步返回、访问器或环不能制造必需能力。

当前 factory 可以装配共享 core 的 generation/query 分支，但本阶段未用实际 Native 短剧包联合验收。Native recovery 仍只支持选用；不能把这套 seam 或普通任务通过视为短剧 8/9/10 的生成、查询和三类恢复已经 ready。

## 5. 上一阶段工厂验证范围

分组存在重叠，不求和。所有最终分组均零失败、零跳过：

| 检查                                   | 结果与范围                                                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 新配置契约和文件 loader                | 38/38，严格数据、凭据引用、文件签发和撤回                                                                                                    |
| 完整 Contracts                         | 388/388，含协议生成和 development license 检查                                                                                               |
| 原 Native 配置/启用 owner              | 35/35，原批准和文件绑定保持                                                                                                                  |
| 新独立 authority 与真实 Native factory | 27/27；其中 5 项通过实际 factory/安装 Node/UI/StandaloneIdentity/SQLite 验证普通任务、个人积分预留、原键重放、独立 UI epoch 和 COMMIT 后关闭 |
| deferred 与原必需 Host 服务窄组合      | 42/42，实际 brand 绑定、捕获、撤回、拒绝伪造                                                                                                 |
| 完整 Plugin Host                       | 308/308                                                                                                                                      |
| 原 Native history/recovery 与共享 core | 65/65                                                                                                                                        |
| 原 Standalone Main 进程                | 1/1，同一 SQLite 两次实际启动、选用和原回执冷重放；未打开新任务 opt-in                                                                       |

Control、Host 和 Contracts 类型检查、boundary、license、格式和 diff 检查通过。最初夹具缺少真实 deployment/prepareCandidate、误用回执错误类型及 COMMIT observer 安装时机，均修正为原真实接口；未放宽产品权限、事务或原断言。原失败日志保留。

一次 Host 类型脚本隐式重建 SDK；后续使用直接 `tsc` 和 Node 测试，未再次调用该构建脚本。SDK 源码和冻结 tarball 未修改，原发行包继续使用原 tarball；原前端源码、正式资产、生产映射和短剧 8/9/10 包通过摘要与实际 Host verifier 复核。本阶段没有前端重建或重新发行插件。

统一证据：`output/extensions/checks/native-task-execution-proof-20261004.json`。当前用户设置页再次实际打开，截图为 `output/extensions/checks/account-settings-opened-20261004.jpg`。原用户服务继续保留。

## 6. 下一步与剩余验收

1. Standalone Main 的 FileIssued 配置和 HTTP Task result/read 已接入；继续审查和接入 Electron 私有 challenge/bootstrap。
2. 用实际 Native 短剧 source→Krea2 target 接通生成/查询和原三类 durable recovery，验证关闭、重启、原 key/CAS、撤权和迟到回执。
3. 接入用户真实个人插件钱包、资金与价格权威及结算；不能用测试 grant/quote 替代。
4. 在可用的真实 ComfyUI 上完成同一次完整 App 保存→生成→原任务查询→选用→重启，以及 packaged Electron/Main/preload/App 验收。
5. 通过第二个实际企业 API 完成 E5 复用验收。

当前测试没有启动在线 Worker 或调用模型/供应商，没有重新请求原 ComfyUI 地址。普通任务工厂机制完成不代表完整目标完成；完整目标继续进行。
