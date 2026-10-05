# 插件工作台共享文本协议 v1

`crewon.project-texts@1` 为插件 UI 提供共享大纲与分集剧本的读取、手动编辑、候选历史、采用和锁定。Short14 使用它读写与 Short13 Agent 项目工具相同的 ProjectText 数据。它是独立公共协议，保留原 SDK 0.1.0、UI invocation v1 和旧六类项目动作；手动文本操作不创建 Run，不经过 Node 任务准备，也不产生积分、外部 operation 或供应商请求。

## 公共入口与独立构建

公共入口是 `@crewon/contracts/project-texts-ui`，导出 portable 类型、`createPluginProjectTextUiClient`、严格请求/响应 parser 和 `projectTextsUiCodec`。服务名为 `crewon.project-texts`，API 版本为字符串 `"1"`；动作精确限定为 `crewon.project-texts.v1.*` 的下表十项。未知后缀、未知版本或仅声明命名空间均不能获得调用权限。

`packages/contracts/src/plugin-project-texts-ui-service.ts` 没有 import，可作为公开单文件随第三方插件分发。它包含服务常量、输入/输出类型和客户端；客户端必须同时接收严格 codec，不接受只做类型强转的替代品：

```ts
import {
  createPluginProjectTextUiClient,
  projectTextsUiCodec,
} from "@crewon/contracts/project-texts-ui";

// services 是真实 SDK UI mount 提供的原 invoke 服务，不是插件构造的身份。
const texts = createPluginProjectTextUiClient(services, projectTextsUiCodec);
const { view } = await texts.getOutline({ projectId }, { signal });
```

仓外插件也可以携带字节一致的 portable 副本，并将公开 codec 预先打成自持 ESM 与声明文件。Short14 的副本是 `src/project-texts-ui-service.ts`，codec 为 `src/project-texts-ui-codec.mjs` 与 `.d.mts`。`build.mjs` 对 portable 与 codec 固定 SHA-256；仓库验证公开源、副本及产物摘要，独立项目只依赖公开协议、已分发的冻结 SDK tarball 和自身源文件，不读取私有宿主实现。

协议升级时应重新审阅公开类型和严格 parser，重新生成 codec，验证副本字节与摘要，再有意更新构建 pin。不能通过删除摘要检查、导入私有 Application/Store 文件或重建冻结 SDK 来消除差异。新安装包的文件清单和 packageDigest 必须按实际产物重算，旧发行包保持原身份。

## 十个方法

每项动作均为表中方法加前缀 `crewon.project-texts.v1.`。列表参数是扁平字段，没有额外的 `query` 层。每次调用可另传 `{ signal }` 取消 UI 等待；客户端不自动重试任何写入。

| 方法                   | 输入                                                     | 响应                                 |
| ---------------------- | -------------------------------------------------------- | ------------------------------------ |
| `getOutline`           | `{ projectId }`                                          | `{ view }`，未保存时为 `null`        |
| `getScript`            | `{ projectId, episodeId }`                               | `{ view }`，未保存时为 `null`        |
| `getArtifact`          | `{ projectId, artifactId }`                              | `{ view }`，未保存时为 `null`        |
| `getRevision`          | `{ projectId, artifactId, contentRevision }`             | `{ contentRevision }`，缺失返回错误  |
| `listArtifacts`        | `{ projectId, afterArtifactId: string \| null, limit }`  | `{ artifacts, nextArtifactId }`      |
| `listRevisions`        | `{ projectId, artifactId, afterContentRevision, limit }` | `{ revisions, nextContentRevision }` |
| `saveOutlineCandidate` | `{ projectId, request, idempotencyKey }`                 | `ProjectTextMutationResponse`        |
| `saveScriptCandidate`  | `{ projectId, episodeId, request, idempotencyKey }`      | `ProjectTextMutationResponse`        |
| `selectRevision`       | `{ projectId, artifactId, request, idempotencyKey }`     | `ProjectTextMutationResponse`        |
| `setLocked`            | `{ projectId, artifactId, request, idempotencyKey }`     | `ProjectTextMutationResponse`        |

读取与写入 DTO 保持[共享文本 HTTP 协议](./project-text-artifact-protocol.md)的字段与校验。四个 `request` 分别为：

```ts
// saveOutlineCandidate
{ expectedArtifactRevision, briefRevision, content }

// saveScriptCandidate；null 表示明确手动导入，无虚构大纲来源
{ expectedArtifactRevision, briefRevision, outline: null /* 或 { artifactId, contentRevision } */, content }

// selectRevision
{ expectedArtifactRevision, contentRevision }

// setLocked
{ expectedArtifactRevision, locked }
```

响应只公开项目、成果头、不可变修订和来源摘要。写回执为 `{ kind, disposition, artifact, contentRevision }`，`disposition` 仅为 `committed` 或经核验的 `replayed`。不公开 actor、principal、安装权威、数据库或凭据。客户端和宿主都严格验证请求及响应的项目/成果定位、CAS、内容、来源与摘要。

## 来源、候选、采用与锁定

大纲候选绑定确切已保存需求修订。剧本候选绑定确切需求修订，并可绑定确切大纲内容修订；`outline: null` 保留手动导入语义。保存增加候选，不自动改变采用指针。采用或锁定使用独立成果头 `revision` CAS；锁定保护当前采用版本，仍允许保存新候选，不能直接采用其他版本。

当前读取的 `view` 包含 `artifact`、`selectedRevision`、`dependencyState` 与 `staleReasons`。需求或大纲采用变化后保留历史正文，由服务返回 `brief-changed` 或 `outline-selection-changed`；UI 不通过改写来源把旧稿伪装成最新内容。打开历史只读取原内容，明确“采用”才修改当前指针；使用新来源也需保留正文、显示新来源，并由用户保存新候选。

已保存数据可在关闭后重新读取；未知写入保留原输入与原幂等键，明确重试只发送原请求。已确认写回执不会因随后的当前视图读取失败而回退为未知。Short14 当前的未确认文本请求与草稿仅保留于本次挂载；冷启动后的未完成文本 intent journal 尚未实现，不能用已确认数据的冷读取或显式同键重放声称它已经可恢复。

## 输入和响应预算

泛 UI invoke 的输入预算仅对精确十个新动作扩至 **60 KiB UTF-8 JSON**。旧动作、未知 text 后缀和未知版本保留 **24 KiB**；Renderer、Contracts 与 Application 使用同一判别，声明命名空间不能扩大预算。新服务每份响应最多 **60 KiB**。

大纲内容仍最多 16 KiB，剧本内容仍最多 32 KiB；字段、场景与对白数量遵守原内容 parser。列表 `limit` 为 1..16，`afterContentRevision` 为非负安全整数。历史超过响应预算时只裁剪完整尾部记录，以最后真正返回的修订作为继续游标；不裁正文、不重新计算摘要，也不将片段冒充完整修订。

## 实际挂载与写事务资格

声明服务不授予项目或执行权限。宿主必须显式启用 `textArtifacts: { version: "crewon.project-text.v1" }` 和精确 `textUi.publications`，后者绑定实际插件、packageDigest 与 `main.content` module contribution。真实来源批准、启用选择、UI 挂载、当前账号/配置档与 UI policy 仍逐项检查。双入口 Short14 为避免 Node 被迫依赖 UI 服务，将其声明为 optional；只有显式批准的 UI module 获得文本调用资格。

四类写入使用独立 `crewon.project-text-plugin-commit.v1` 资格。它来自实际 `PluginUiApplicationService` 的 invocation WeakMap，绑定完整 actor、八字段安装 tuple（tenant/space/profile/plugin/publisher/version/packageDigest/selectionRevision）、实际 action/input、完整原 selection/package 和 transaction-safe current 回调。复制 context、JSON 自报授权或构造 Run 均不能获得资格；输入不接受 caller 指定 actor 或安装身份。

旧 UI 六动作事务资格继续拒绝新文本写入；旧 UI、真实 Run 工具和新 text UI 三类事务资格互斥。Application 将实际输入、项目命令及原幂等键逐项绑定，Store 在写入或读取同键回执时重新核验当前完整安装。重放不是绕过当前权限或用新包改写旧请求的通道。

PostgreSQL 使用已经借出的同一个提交连接检查安装，并以 `FOR SHARE` 锁住真实 selection/package 行。提交前的外部项目 PDP、UI profile 与 epoch 回调不再次借父连接池；`maxPoolSize: 1` 的真实 HTTP 流程已经验证。SQLite 异步权限检查在写事务外完成，`BEGIN IMMEDIATE` 内核验安装，COMMIT 前再次同步检查当前 invocation/owner。关闭立即撤回新操作，并等待在途调用实际退出。

确认 COMMIT 后由真实文本服务结果签发私有、一次性、绑定原 context 的 metadata receipt。迟到关闭或撤权不把已经确认的写入改报为未提交；普通读取与重放仍需当前权限。该回执没有任务准入或资金含义。

## 验证范围

协议与 owner 验证包括 Contracts 全量 **462/462**、新 owner 与旧调用链组合 **76/76**。新事务资格真实 SQLite/PostgreSQL **15/15**，旧 Application **33/33**、旧 Store **74/74**；Control/Native 组合 **120/120**，独立 production PostgreSQL 单连接 HTTP **1/1**，原审批与 Loader UI **31/31**。各组有重复覆盖，不能相加为独立总数；所列专项零跳过。

实际隔离安装、挂载及原 HTTP 动作覆盖十方法、四类写入、超过旧 24 KiB 的合法剧本、当前 Project PDP/UI policy 拒绝、停用拒绝、已确认数据冷读取及同键复播；原 Node peer、Run、funding、外部 operation 和供应商请求均为零。证据位于 `output/extensions/checks/project-text-ui-20261005/`。

这些是真实组合与数据库验证，不代表实际用户 `.app` 已更新或已完成 Agent 项目对话启动。独立插件 DOM 和 Chrome 视口截图使用明确公共 DTO fixture，不提供生产身份或 SQL 证明。原宿主导航、账户入口、左右栏及全局 CSS 未改；实际 App/profile、本机网络和原未知 Krea operation 保持未动。
