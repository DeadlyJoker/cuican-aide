# 原生插件历史恢复：下一阶段实施顺序

日期：2026-10-02。不可变恢复输入、实际发布核验、当前 Worker 就绪后提交记录，以及当前 Provider 凭据查询模块已落地；自动历史宿主尚未接入。当前已交付范围见[进程启动说明](./extension-process-startup.md)及[实施进度](./incremental-extension-progress.md)。继续采用现有 Node / TypeScript 发布与执行路径；短剧产品形态仍按[参考结论](./short-drama-workbench-reference.md)后置。

## 先准备不可变恢复输入

Native release 生成的当前 `agent-version-runtime-bindings.json` 仍会在下次启动时覆盖；七包代码归档不包含配置。现已额外在原生数据目录的 `extension-recoveries/<capsuleId>` 保存可核验的非秘密恢复输入，再增加自动进程管理。

两层身份必须分别处理：AgentVersion 的 `contentDigest` 覆盖版本、模型、指导、执行规则、资源和工具定义；部署的 `materializationDigest` 还覆盖完整 binding 和引用配置，包括配置路径、模型 endpoint 及凭据环境变量名称。顶层 bindings / assets 文档可以按原字节复制，已发布 binding 内的路径不能在升级后重定位。

尚未发布的 asset 可以保留原值；在首次发布前为 snapshot 分配最终路径、复制并修改 binding 引用，只产生新的 materialization。必须重新核对实际工具和资源契约。已在数据库发布的同一 Agent ID 则保持原路径、原内容验证，不能用恢复快照替换其部署身份。

| 恢复输入                   | 保存要求                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 插件 assets                | 原完整资产及字节摘要，不重写模型、工具或指导                                                                     |
| 插件 bindings              | 完整集合，引用发布前确定的最终 snapshot 路径                                                                     |
| 每个 `extensionConfigPath` | 完整配置 revision、approvalRequirement 及字节摘要                                                                |
| 基础 bindings              | 保存此次 release 的完整输出，恢复时核对完整发布部署集合                                                          |
| 恢复 manifest              | 严格版本、完整 owner、两个代码归档摘要、真实 release ID、完整 prepared targets、上述文件摘要和允许的非秘密启动值 |

启动值采用明确字段白名单，不能保存整份环境。除 route、model ID、endpoint 外，还需捕获实际输出上限（包含未设置语义）、context / compact 参数、instructions、执行重试与工具轮数，以及有效 Responses / WebSocket 设置。解析应复用生产入口，不能让快照与实际 release 使用两套默认值。

API key、session / CSRF / private / probe token、artifact key、数据库连接秘密及任意 MCP `env` 都不进入快照。完整代码摘要和文件摘要只证明输入身份，不能授予发布权或执行权。

首个可验收切片限定可证明非秘密的 directResponses、无 workspace、无插件辅助 MCP / device / remote 配置。不能完整冻结的场景仅标记为不支持自动历史恢复；当前 Native 启动和已有 workspace 工具继续沿原路径工作。现有固定位置的 `local-workspace-mcp.json`、当前安装 MCP 入口以及 cloud Agent 等输入另行解决，不声称通用复制即可恢复。

### 落地顺序

步骤 1–4 已接入打包版桌面的实际 release / Worker / Control 路径。`manifest.json` 是最后发布的完整记录标记；固定启动交接文件只传当前尝试的候选或明确不可用结果，不能代替完整记录。源代码模式不自动归档或准备记录。第 5 步中的 Provider Store 查询已实现，自动旧 Worker 仍待接线。

1. 增加独立快照模块，采用有界严格 schema、普通文件、无符号链接、独占创建及不可覆盖发布；首次 release 前确定最终路径。
2. 冻结插件文件、有效 bootstrap 参数及工具来源，仍调用现有授权发布入口。对已有部署不改写绑定。
3. release 成功后封存完整基础 bindings 和真实发布结果；核对 bundle、assets、deployments 与代码归档，准备待提交记录。
4. Worker 的实际 owner / registration / 完整目标挑战通过后，以最后发布的 complete marker 提交可恢复记录。失败不伪造完成状态，不删除已发布输入；恢复时重新核对全部字节和数据库记录。
5. 再接当前凭据解析和自动历史 Worker。恢复只执行已保存构建的 Worker，不再次 release，也不切换默认 Agent。

已发布输入与本次恢复资格分开处理：当前 default/catalog 或 workspace 变化后，能完整匹配的已保存插件文件仍使用原固定路径，首次有效的 bootstrap、基础 bindings 和 release 不覆盖。当前 Provider ID 或凭据要求变化只影响恢复候选；改变完整模型 endpoint 或缺少旧绑定所需的当前秘密时，当前宿主不装配旧插件，默认 Agent 和目录宿主继续启动。历史记录仍保留原 Provider 绑定，后续必须通过当前 Store 精确查询，不能将新服务的密钥发往旧服务。

旧版已经在原操作者路径发布的目标不会自动搬迁。操作者将当前配置显式改为保存的文件后，可以在删除原文件的情况下继续当前执行；这不等于已实现自动选择旧记录。该选择改变原 bindings 字节，可能只返回不支持新的恢复记录，已有完整记录保持不变。自动记录选择与升级后的旧 Worker 生命周期留在下一步骤中处理。

当前可复用 `loadExtensionReleaseInput` / `mergeExtensionReleaseInput`、`agentVersionDeploymentCandidates` / `runtimeExtensionTarget`、`compileRuntimeAgentVersionRelease` / `verifyRuntimeAgentVersionRelease` 及 `retainExtensionBuild` / `resolveRetainedExtensionBuild`。恢复核验不要求该旧 release 仍是当前默认指针，但要求其原 bundle、资产与部署完整匹配。

## 当前凭据和进程管理

凭据从当前 Provider Store 按保存的 `providerId` 和规范化 endpoint 共同匹配，再取当前可用秘密；同时核对该 Provider 的 Responses 地址与每条使用该凭据的实际模型路由。同一地址的密钥轮换可以继续，地址改变、删除或所需秘密不可用只使该历史宿主不可用。明确无鉴权绑定须与凭据缺失区分。现有 `secretFor(providerId, environmentVariable)` 允许草稿环境变量覆盖且只按 ID 查找，不适合历史恢复；不能回落到当前 active Provider 的密钥，也不能仅按相同 origin 发送凭据。

首切片只支持能够证明对应所选 Provider 的路由和明确凭据引用。任意配置里的环境变量名称不能充当该证明；同一环境变量被用于其他 endpoint、无法证明凭据 owner 的自定义路由，只影响自动恢复资格，不阻止原当前启动。以后支持多 Provider 时逐路由保存并重新匹配引用。

历史管理抽为聚焦模块，最多四个宿主，每个最多 32 个完整准备目标。只接受明确提交的恢复记录和 scope.v1 归档，不从目录中的任意文件猜测可执行版本。每次启动清洗 ambient 覆盖、固定完整桌面 owner、轮换 token，直接监督实际 retained Worker，并在首次 await 前登记进程所有权。

实际端口经现有私有挑战验证 owner 后，还要验证预期插件登记和完整目标。仅把验证后的 peer 交给 Control 的历史查询端口。离线或不支持的历史宿主不能阻止当前 Control / Worker 启动，也不能借当前新目标替代旧目标。

Supervisor 的当前健康状态与全部进程所有权需分开：`session()` 和当前 readiness 只依赖当前 Control / Worker；历史退出只处理该宿主。停止尝试所有自有进程，终止失败继续保留句柄，不能启动重复进程。历史端口 / token 变化后更新 Control 接线的首个实现可受控重启 Control、保留当前 Worker，并验证 SSE 游标恢复；Provider、workspace、配置切换仍按原整体重启语义处理。退出路径也需等待有界清理。

## 验收证据

- 首次发布前准备输入，保持 asset 摘要；已发布目标拒绝重定位。覆盖异步修改、秘密字段、残缺 marker、篡改、容量、并发及中断。
- 实际 Provider Store 的同地址轮换、地址错配、删除和不可用检查，不使用合成秘密解析成功冒充真实接线。
- 真实 Node Supervisor 验证历史失败不影响当前、四宿主上限、关闭 / 重启 / 快速退出 / 终止失败的所有权，以及私有端口更新后的流式重连。
- 接已有两份独立七包构建夹具，证明升级后的旧任务和旧查询仍使用原完整目标；删除当前安装资源后也能恢复，旧查询不新增生成 POST。
- 插件关闭和不具备自动恢复能力时，原默认 Agent、providerAgent、workspace 工具、普通任务与 Provider probe 保持原行为。公共目录、配置、激活和新生成继续只接当前宿主。

生产权威身份协议和第二个实际企业 API 保留为独立待补输入；本阶段不据此构造替代身份或虚构企业 API。
