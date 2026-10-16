# 包边界中的宿主适配器登记

2026-10-08。本次登记补齐现有实现与架构边界检查之间的缺口，不新增运行时、授权来源或产品入口。登记以明确的源文件和完整 import specifier 为单位；包默认限制、公开 SDK 和 React 渲染端限制继续保留。登记不能代替业务权限、安装选择、Run 资格、实际字节核验或真实外部服务验收。

## 共享媒体包

[共享媒体生成命令的模块边界决定](./shared-project-media-commands.md#模块边界决定)已经明确：Control 与 Worker 复用私有 `@crewon/media-runtime`，不能让一个 app 生产依赖另一个 app。包使用现有 TypeScript/Node 工具链，依赖 Application、Artifacts、Domain 和 Store。素材协调归共享包，原模型、Tool、Run 调度和恢复仍归 Worker。[Worker 组合协议](./project-media-worker-composition-protocol.md)保留旧模块重导出与共享实现的身份。

包策略因此登记上述四个依赖，同时将 Node 能力限定到实际适配文件。例如 `pinned-node-http.ts` 使用 HTTP/HTTPS 和网络地址校验，`provider-probe-egress.ts` 使用 DNS/网络地址审查，`project-material-png.ts` 使用 zlib，素材摘要和非执行型输入验证分别使用 crypto、util。没有给予整个包 `node:` 通配许可。

源材料导入沿此私有包边界实现。`project-source-import.ts` 只登记 `node:crypto`，`project-source-import-validation.ts` 只登记 `node:util`；HTML 解析的正式依赖 `parse5` 仅允许 `project-source-html-parser.ts` 导入。它用于解析上传字节，不是浏览器或资源执行器。章节提取和其他导入模块没有取得 HTTP、文件系统、子进程或任意 parser 子路径许可。该登记不表示 HTML 导入、上传 journal 或产品按钮已验收完成。

`project-source-upload-preparation-adapter.ts`单独登记crypto/util：实际原字节SHA-256及原生typed-array快照、Proxy拒绝。它只适配新Application字节/解析端口，沿现有parser，既有PNG快照预算不变；不取得上传HTTP、文件系统或数据库权限。相邻上传模块仍拒绝这些未登记能力。

## Application 中的宿主资格和输入验证

Application 默认仍只依赖 Contracts 和 Domain。纯领域值、应用端口与新源材料端口没有 Node 许可。既有宿主资格对象和严格输入记录有以下精确例外：

| 实现范围                                                                                                                           | 已有用途与证据                                                                                                                                                                            | 登记限制                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `creative-project-run-commit-authority.ts`、`project-asset-run-commit-authority.ts`、`project-media-input-run-commit-authority.ts` | 真实 Run、Tool 回执、原请求与安装快照的摘要绑定；见[已安装项目动作](./installed-plugin-creative-project-actions.md)及[媒体输入 Agent 工具](./project-media-input-agent-tools-protocol.md) | 仅 `node:crypto`                                           |
| `project-text-plan-authority.ts`、`plugin-ui-invocation-authority.ts`                                                              | 实际 UI 调用委托、原计划快照摘要及不可伪造的宿主调用身份；见[文字计划协议](./plugin-project-text-plans-protocol.md)                                                                       | 仅 `node:crypto`                                           |
| 媒体输入、结果、采用、素材准备与冻结记录的已列名实现                                                                               | `types.isProxy` 在读取描述符前拒绝 Proxy；摘要由准备记录核验；见[素材 journal](./project-material-preparation-journal-protocol.md)及[准备服务](./project-material-preparer-protocol.md)   | 各文件仅实际使用的 `node:util`，准备记录另有 `node:crypto` |

具体文件全集在 `packages/test-contracts/src/package-boundary-policy.ts`。上述许可没有扩展成 Application 的 Node 默认依赖。文件系统、HTTP、子进程、Store 和媒体执行器依赖仍被拒绝。模型 JSON、插件 DTO 或渲染端都不能因为这些文件存在而取得宿主资格对象；渲染端仍禁止导入整个 Application。

## 插件宿主与 app 组合

[已安装插件任务启动](./installed-plugin-task-startup.md)、[任务 Core](./installed-plugin-task-runtime-core.md)及[Native 本地执行](./native-local-plugin-execution.md)已经明确宿主组合归属：Control 编排 HTTP、身份和原父 Store，Worker 加载确切已安装包并执行原 Run，私有 Plugin Host 通过显式业务桥接调用 Application/Domain 端口。宿主配置读取有独立的私有文件、规范路径、所有者、长度和权限约束；这些读取不属于插件或渲染端。

Plugin Host 仅给已有任务、生成、上下文、查询和历史业务桥接文件登记实际 Application/Domain 入口；服务可用性文件只登记各自公开 Contracts DTO 入口。默认加载器仍不能导入 Application/Domain、Store 或媒体包。原精确 SDK Node/Contracts 入口规则保持，未开放 SDK 根入口、UI 入口或私有子树。

`packages/test-contracts/src/app-boundary-policy.ts` 分别登记 Control 与 Worker 的实际安装组合和媒体适配文件。Control 的文件系统、路径、Proxy 检测和请求异步上下文能力仅登记在对应宿主配置/组合文件；媒体包与 Plugin Host 也按完整入口登记，未增加 app 级默认通配依赖。Worker 的 SDK Node/Contracts 导入是既有媒体适配器的类型引用，不据此添加 SDK 运行时依赖。原 CLI 的 `process-lifecycle` 和 `node:net` 许可与新登记合并保留。

项目基础信息与原文准备沿上述组合边界新增四条精确登记。`plugin-project-foundation-host-service-availability.ts` 只读取 `@crewon/contracts/project-foundation` 的公开服务名称和版本；`project-foundation-plugin-ui-composition.ts` 与 `production-project-foundation-plugin-runtime.ts` 各自允许 `@crewon/plugin-host`，分别组合真实 Application 服务的安装发布可用性、原 HTTP 身份和请求生命周期。`project-foundation-composition.ts` 允许 `@crewon/media-runtime`，仅用其中的 `ProjectSourceUploadPreparationAdapter` 适配已有上传准备端口，实际 Store 仍借用原父数据库。生产配置显式启用并分别提供项目与上传策略，不映射原创意项目授权，也不允许测试种材料使用的信任选项进入正式配置。

上述登记没有赋予其他文件、嵌套路径或包私有子路径同等许可；Foundation 可用性也不意味着取得 Run、原始字节传输或调用资格。独立 SDK `project-foundation-ui` 入口仅含可移植 DTO 校验与原 `services.invoke` 客户端；渲染端对 Application、Store、媒体包、Plugin Host 和 SDK Node 的禁止规则保持。真实安装的 HTTP 测试辅助文件 `project-foundation-plugin-ui.integration.test-support.ts` 已由原 `.test-support.ts` 识别规则排除，不需要新增产品导入例外，且仍不能从 renderer 生产入口引用。

独立上传 UI 发布再登记三条精确依赖：两种可用性组合共用 `plugin-project-foundation-host-service-availability.ts`，因此该文件另外允许公开 `@crewon/contracts/project-source-uploads`；`project-source-upload-plugin-ui-composition.ts` 与 `production-project-source-upload-plugin-runtime.ts` 各自仅额外允许 `@crewon/plugin-host`，分别组合品牌上传服务和原 HTTP 请求身份/生命周期。正式配置以 `foundation.uploads.pluginUi` 单独批准上传服务，不继承 Foundation 发布。SDK `project-source-uploads` 入口复用四个严格 JSON 动作，分片字节通过另行提供的原生传输端口，每片不超过 65,536 字节，不注入 JSON/base64，也不创建 Run 或授予上传权限。上述登记及 SDK 传输测试不表示正式安装 UI 的原文上传已完成验收。

Foundation Node 工具沿[原 Native 执行](./native-local-plugin-execution.md)和[短剧 P1 兼容边界](./reelbench-replication-p1-compatibility.md)新增五个精确适配文件。Control 的 `desktop-project-foundation-plugin-runtime.ts` 只导入 Plugin Host 的现有可用性端口类型，用真实私有 bootstrap、原项目 owner 和已安装 UI 发布组合 Foundation/上传服务。Worker 的 `plugins/installed-plugin-project-foundation-tools.ts`、`plugins/project-foundation-tools-service-owner.ts` 只取得 Plugin Host 服务/候选类型及 SDK Node 原工具上下文类型；`plugins/project-foundation-runtime-scope.ts` 只取得该 SDK 上下文类型；`plugins/installed-plugin-runtime-project-services.ts` 只取得原安装候选类型。它们沿原 Run、Tool 回执、安装选择和父 Store 验证，不新增模型执行器、数据库或授权来源。独立 Native Node 声明不继承 Foundation UI 发布，也不依赖 Comfy 配置。SDK 根入口、UI 入口、私有 Host 子路径、相邻及嵌套文件均未开放；没有增加 Worker 的 SDK 运行时依赖。这些登记和静态反向测试不能代替正式安装包的流式/恢复验收。

## Store 的物理适配例外

`project-media-generation-turn.ts` 的 `node:util` 用于拒绝 Proxy，`project-text-store-support.ts` 的 `node:util` 用于核对重建值与实际持久值。它们属于既有存储记录核验，未给予整个 Store `node:util` 许可。

新增`project-source-upload-store-support.ts`的util例外也仅用于原生raw字节复制前拒绝Proxy。纯Application上传端口仍没有Node权限；双库journal借用原宿主数据库，不开放新的持久化运行时。

`sqlite-plugin-installation-profile-lock.ts` 的 fs/path 用于原 SQLite profile 锁的真实位置、文件身份、私有锁目录与同一安装事务协调。该文件已有物理存储适配责任；精确登记不允许邻近 Store 模块取得任意文件读取，也不将路径字符串视为安装权限。[已安装插件任务启动](./installed-plugin-task-startup.md)要求 Control/Worker 共享真实安装台账和选择，存储锁仍须执行其原身份核验。

## 测试辅助文件与渲染端

原 `InstalledPluginModuleTaskContext.test-support.tsx` 在 Node 测试环境读取实际独立包并计算摘要，配合[安装式任务上下文专项](./installed-plugin-ui-task-context.md)；它只由集成测试引用。边界检查原已识别 `.test-support.ts`，本次补齐对应 `.test-support.tsx`，并检查真实 renderer `main.tsx` 的传递相对依赖：生产入口不能通过本地重导出或动态 import 进入任何测试辅助文件。

渲染端继续禁止 Node、Application、Control、Store、Plugin Host 和 SDK Node；同时明确禁止共享媒体包及其子路径。公开 SDK UI/Contracts 仍按原边界使用。不得将宿主 Run/Tool 资格代码标为测试辅助文件，再从产品入口引用。

## 检查方式

原包/应用源文件扫描、完整依赖表及环检测继续运行。新增反向行为测试验证精确文件、邻近文件、嵌套路径、未登记子路径及无关能力的拒绝；另覆盖 parser 只能在单个模块使用、旧 CLI 例外没有被合并覆盖、测试辅助文件不能进入生产依赖图。这些是静态架构规则与规则行为验证，不是实时生图、原文导入或正式 App 可用性验收。

后续新增适配文件或外部依赖需要给出归属证据，再补明确登记与反向拒绝测试；不得根据当前扫描结果自动生成运行时 allowlist，也不得通过删除有效测试使违规导入通过。

## 基础回归发现的类型适配遗漏（2026-10-09）

完整源扫描发现先前结构化大纲提交 `0a961a67b` 的两个文件未登记。逐项核对后，`plugins/installed-plugin-project-outline-tools.ts` 只从公开 Host 入口获取安装候选类型，`plugins/project-outline-tools-service-owner.ts` 只获取 Host 服务类型；两者都仅从 SDK Node 获取原 `PluginToolRuntimeContext` 类型。服务执行仍通过既有 Application、原 Run/Tool 资格和父 Store，不引入插件执行器、文件装载器或新权限。因此按既有 Foundation 适配模式登记这两个精确文件的四条类型边，不向整个 Worker 开放 Host/SDK。

反向测试继续拒绝相邻文件、嵌套路径、私有 Host 子路径、SDK 根/UI 及无关媒体能力；渲染端禁止规则不变。另两处 Native DNS 类型导入改为原 Worker `network-egress.ts` 稳定入口，没有扩大共享媒体的许可范围。该修复补齐静态边界登记，不重新启用业务插件，也不证明结构化大纲产品已验收。

同一提交的 `plugin-ui-host-service-availability.ts` 使用两个独立公开契约的服务名/版本常量，核对实际 Host 可用性，不提供服务对象或调用权限。因此仅该可用性适配文件额外登记 `@crewon/contracts/project-outlines` 与 `@crewon/contracts/project-outline-edits`，相邻模块仍禁止这些子路径。Store 的结构化大纲比较则直接复用原 `textEqual`，它保留相同的严格比较和错误码，删除重复 `node:util` 导入，没有新增 Store 例外。

## 共享 PIM 沙箱适配器归属（2026-10-16）

Worker 原先通过跨应用相对路径直接加载 Control 的 `pim-sandbox-client.ts`，导致生产类型图和工具执行依赖 HTTP 服务应用。该适配器负责远程沙箱目录、文件、Git 和命令派发，归入已有 `@crewon/device-dispatch/pim-sandbox-client` 公开子入口；Control 原路径保留兼容重导出，Worker 改用公开包入口。实现和错误类身份保持一致，没有新增执行器或修改网络协议。

`node:path` 仅许可给 `device-dispatch/src/pim-sandbox-client.ts`，移除 Control 旧文件的对应例外。Control 登记对 Device Dispatch 的运行时依赖。既有沙箱测试继续覆盖响应体上限、取消、未知执行结果、写入串行及清理失败；不放开 Renderer 权限。

两个服务增加 `typecheck:production`，用于隔离生产代码的本地检查。原 `typecheck` 与 CI 完整检查仍包含全部测试。新增解析 TypeScript 实际依赖图的边界测试，防止 `exclude` 下的测试辅助或其他应用通过传递导入重新进入生产检查。
