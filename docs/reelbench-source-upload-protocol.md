# 小说原文上传与持久化协议实施规格

状态：**内部上传日志、解析服务和双库实现已完成；正式产品入口尚未注册**。TXT / Markdown / HTML 字节解析器保留不变。当前已通过实际原字节、64 KiB分片、20,000,000字节文件、解析claim及重开恢复的SQLite/PG验证；同事务项目关联已落盘，独立采用权限及真实双库集成已验证；GC、宿主安装资格注册、SDK/两端上传transport与HTTP/BFF路由仍待实施。`sourcePreparation`仍未连接到正式创建页面，不代表用户已经能够上传原文。

已实现入口：[Application服务](../packages/application/src/project-source-upload-application-service.ts)、[纯端口与PDP](../packages/application/src/project-source-upload-port.ts)、[实际字节和解析适配器](../packages/media-runtime/src/project-source-upload-preparation-adapter.ts)、[SQLite](../packages/store/src/project-source-upload-sqlite-store.ts)、[Postgres](../packages/store/src/project-source-upload-postgres-store.ts)、[独立schema](../packages/store/src/project-source-upload-schema.ts)。[双库集成](../apps/control-api/src/project-source-upload.integration.test.ts)通过实际数据库验证原字节/正文摘要、重复分片、CAS、不可变记录、不同actor同principal、物理重开、过期claim及同claim结果重放；[解析故障恢复](../apps/control-api/src/project-source-upload-adapter.integration.test.ts)另覆盖规范正文扩容拒绝、未知解析故障恢复和孤立测试中raw payload清理后的canonical读取。后者只模拟未来GC效果，尚无产品GC执行器。

## 1. 既有能力与不能复用的边界

| 对象           | 已有事实                                                                                                                                                                                                                                                                                                                                       | 本阶段复用方式                                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原文字节解析   | [project-source-import.ts:35](../packages/media-runtime/src/project-source-import.ts#L35) 接收实际 `Uint8Array`，输出原字节摘要、规范正文摘要、标量安全正文分块和章节偏移；不创建项目、不执行工作流                                                                                                                                            | 直接调用现有解析器，不另写 HTML 或编码解析                                                                                                                |
| 字节快照       | [material-byte-snapshot.ts:10](../packages/media-runtime/src/material-byte-snapshot.ts#L10) 通过原生 typed-array getter / copy 拒绝代理和调用方访问器；既有通用复制器最大约 16 MiB                                                                                                                                                             | 复用实际字节快照原则；20 MB 原文继续用 [sourceImportBytes](../packages/media-runtime/src/project-source-import-validation.ts#L73)，不提高旧媒体复制器上限 |
| 图片冻结与归档 | [ProjectReferenceMaterialFreezer](../packages/media-runtime/src/project-reference-material-freezer.ts#L30) 校验真实来源、归档重放和再次授权；[FilesystemProjectMaterialArchive](../packages/artifacts/src/filesystem-project-material-archive.ts#L38) 为 PNG 设置 16 MiB 上限并先发布不可变 intent                                             | 复用“原始键、真实摘要、不可变记录、缺失不重新取源”的模式；不把 PNG archive 扩成小说数据库或同事务上传证明                                                 |
| 外部图片上传   | [comfyui-material-upload.ts:25](../packages/media-runtime/src/comfyui-material-upload.ts#L25) 是 `/upload/image` 的 PNG 供应商请求；[ProjectMaterialPreparer](../packages/media-runtime/src/project-material-preparer.ts#L60) 具有单次供应商 dispatch 日志                                                                                     | 保持原样。小说原文上传到 CrewON 宿主，不发给 ComfyUI，不借用付费媒体 dispatch 状态                                                                        |
| 插件请求恢复   | [PluginUiIntentJournalStore](../packages/application/src/plugin-ui-intent-journal-store.ts#L29) 保存小型命令，业务宿主确认 receipt；[插件恢复路由](../apps/control-api/src/plugin-ui-recovery-route.ts#L69) 限制 24 KiB JSON                                                                                                                   | 复用确认前先 stage、确认后按原键恢复的顺序。增加 foundation 命令恢复需要独立兼容测试；不能把原文、分片或整本章节正文放进去                                |
| 原文准备端口   | [PreparedProjectSource](../packages/application/src/project-source-preparation-port.ts#L31) 已校验 owner、摘要和规范分块，注释明确它不能证明未提供的原字节                                                                                                                                                                                     | 加宿主 ledger 来源指针，项目 Store 必须查真实记录，不能接受调用方伪造的 prepared DTO                                                                      |
| 项目提交与重放 | [foundation application service:193](../packages/application/src/project-foundation-application-service.ts#L193) 在准备文件前先查业务 receipt；[SQLite Store:297](../packages/store/src/project-foundation-sqlite-store.ts#L297) 和 [Postgres Store:322](../packages/store/src/project-foundation-postgres-store.ts#L322) 在事务内先查 receipt | 保持 receipt 优先；已成功的重放不要求临时原字节仍在，也不重新解析文件                                                                                     |

## 2. 两端使用同一份协议，分片限 64 KiB

采用固定 `rawPartBytes = 65_536`，整个原文件限 `20_000_000` 字节，最多 306 片。每个非最后分片必须恰好 65,536 字节；最后一片按已登记总长度计算，禁止空片、空文件、重叠、越界和以字符偏移代替字节偏移。

精确传输约束：

- [Desktop HTTP v2:6](../apps/crewon-ui/src/lib/desktop/desktopHttpProtocol.ts#L6) 每个请求允许 2 MiB，**当前并发请求体**合计16 MiB；[请求完成后的释放](../apps/crewon-ui/electron/desktopHttp.ts#L138)会扣除对应字节，不是整个上传累计16 MiB。因此20MB文件可以按64KiB分片逐步发送，不扩IPC预算或增加新文件读取桥。上传客户端初版最多并发2片，只切取正在发送的文件片段，不预先排入整本文件；保留原会话与其他请求的预算。
- [Web BFF:31](../apps/web-bff/src/web-bff.ts#L31) 普通请求体限 64 KiB；[Control API:349](../apps/control-api/src/control-api.ts#L349) 默认请求体也是 64 KiB。上传 raw 路由严格使用这一个分片上限，**不修改全局 body limit**。
- 现有 [BFF plugin 路由白名单:112](../apps/web-bff/src/plugin-proxy-policy.ts#L112) 会拒绝未登记路径，[现有请求解码:348](../apps/web-bff/src/plugin-proxy-policy.ts#L348) 只接受 JSON。新增显式 raw 路由分支和有界字节读取器，不能把 raw 请求塞进现有 JSON 解码器；不能用通用 proxy 绕过 allowlist。
- [网页 host](../apps/crewon-ui/src/lib/plugins/controlPluginUiHost.ts#L70) 和 [桌面 host](../apps/crewon-ui/src/lib/plugins/desktopPluginUiHost.ts#L70) 已共享 `ControlApiClient`。桌面从 [controlRuntimeBootstrap.ts:57](../apps/crewon-ui/src/lib/control-runtime/controlRuntimeBootstrap.ts#L57) 取得原 session / CSRF / main-process fetch；网页沿原 authenticated fetch 与 BFF 身份链路。开发桌面、打包桌面和云端使用相同 URL、字段、分片长度、响应与恢复语义，字节落在各自当前 Control 宿主的同一原数据库。

建议宿主 API 前缀：`/api/v1/plugins/ui/mounts/:mountRef/source-uploads`。这些是下一阶段新增的正式宿主路由，目前不存在：

| 动作        | 方法及路径后缀                                             | 内容                                                                                                                                                               |
| ----------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 登记        | `POST /source-uploads`                                     | 小型 JSON：`idempotencyKey, fileName, format, byteLength, fileDigest`；返回宿主生成 `uploadId`、固定分片大小、状态                                                 |
| 状态 / 恢复 | `GET /source-uploads/:uploadId`                            | 状态、已确认片索引、缺片索引、明确错误、保留期限；不返回 raw bytes 或整本正文                                                                                      |
| 分片        | `PUT /source-uploads/:uploadId/parts/:index/:rawDigestHex` | 唯一允许 `application/octet-stream` 的请求；body 为实际字节；index 推导固定 byte offset，摘要必须是实际 SHA-256；摘要放在规范路径中，不新增任意可转发自定义 header |
| 完成解析    | `POST /source-uploads/:uploadId/prepare`                   | 小型 JSON / 空命令；只封存字节、解析并保存规范结果，不创建项目或 dispatch                                                                                          |
| 取消        | `DELETE /source-uploads/:uploadId`                         | 取消未完成、未关联的上传；不可删除项目已采用的不可变成果                                                                                                           |

所有路由都验证 authenticated actor、当前 mount、声明的宿主服务、当前安装与能力授权、CSRF / origin、请求 deadline 和容量。raw route 用 encapsulated content parser / 有界 reader，拒绝 JSON、压缩正文、超限流和错误 Content-Length；只在完整原字节持久化后确认该片。其响应仍是小型、版本化、不可缓存 JSON。

现有 [PluginUiServices](../packages/plugin-sdk/src/ui-types.ts#L11) 仅支持 JSON `invoke`，[TrustedPluginUiLoader](../apps/crewon-ui/src/lib/plugins/trustedPluginUiLoader.ts#L271) 也只提供这一入口。需新增可声明、可检测的浏览器宿主上传服务，如 `services.sourceUploads.upload(file, options)`，由宿主验证真实 `File / Blob`、拆片、调用原 client 并返回小型上传引用。它不向插件暴露凭据、任意 fetch、文件系统路径或底层 Store。旧插件不声明该服务时行为不变；旧宿主缺失时明确不可用，不偷偷回落到 JSON/base64。Agent 只得到已登记的 `{uploadId, fileDigest}`，不接收浏览器文件字节。

## 3. 不可变上传与多项目关联

初版建议把 raw 分片和 prepared 规范分块置于**原数据库**的独立上传命名空间：SQLite 用 BLOB、Postgres 用 bytea；每条 raw 数据最多 64 KiB，正文每块沿用 4,096 UTF-8 字节。这样 foundation Store 可以借当前连接查 ledger，不引入第二个数据库、运行时、供应商上传或事务中的文件 I/O。文件归档的安全模式可以参考，但外部文件描述符不能替代同事务 ledger。

建议持久化对象：

1. `project_source_uploads`：宿主生成 `uploadId`、迁移生成的 `storageRealmId`、`tenantId / spaceId / ownerPrincipalId`、`createdByActorId / createdAt`、最初请求摘要、文件名、显式格式、完整 `byteLength / fileDigest`、固定分片规则；上述身份字段不可修改。
2. `project_source_upload_parts`：不可变 `index / byteOffset / byteLength / rawDigest` 描述；真实字节放在独立 `project_source_upload_part_payloads` 中，同一分片接收事务同时写入描述和 payload。相同 index / 原摘要 / 原字节重试是 replay；相同位置不同字节是 conflict，不覆盖旧片。payload 在保留期内不可修改，只能经独立授权的 GC 删除；删除不能修改历史描述，raw-sealed / ready 之后也不能靠重复 PUT 恢复成接收状态。
3. 独立 head / events：revision CAS 管理 `receiving → raw-sealed → preparing → ready`；`rejected / cancelled / expired` 为终态。缺片时保持 receiving；prepare 调用失联时查询原状态；进程崩溃后可通过带期限的解析 claim 再执行同一纯解析，不能生成替代 uploadId。
4. 不可变 raw 封存 manifest：全部片的有序摘要、位置和长度、实际整文件摘要、整文件长度、封存时间及 `uploadDigest`。
5. 不可变 prepared manifest、规范分块、章节：`normalizationParserVersion`、原上传封存指针、实际规范 UTF-8 `digest / normalizedByteLength`、`characterLength`、chunk / chapter count 和各自 manifest root、`preparedDigest`。解析版本应覆盖编码、换行、HTML 提取、章识别规则和 parse5 版本。旧 ready 上传不能被新版 parser 静默重新解释。
6. `project_source_upload_associations`：同事务写入 owner、upload / prepared 指针、`projectId / sourceRevision / sourceDigest`、创建 actor / 时间和原 foundation 命令 receipt 标识。一个上传可关联多个项目和同项目多个不可变 source 版本；**没有 single consumed boolean**。项目之间保留独立 foundation、proposal、source 版本，不通过共享上传传播改动。

封存摘要必须签入完整关系：schema/version、storage realm、owner、uploadId、最初请求摘要、文件名/格式、whole byteLength/fileDigest、每片 index/byteOffset/byteLength/rawDigest；prepared 摘要还签入 parser version、规范正文摘要/长度、分块及章节清单摘要。每块正文使用标量偏移，每个 raw 片使用字节偏移，不能混用。

摘要按 SHA-256、明确 domain separator 和规范字段编码产生。raw 最多 306 片，可使用有界 canonical manifest；正文和章节清单可能很大，应逐条规范编码并有序累计 manifest hash，不将整本正文或巨型数组塞进 `extensionCanonicalJson` 的小型 JSON 上限。任何摘要或客户端“签名”只用于一致性，**不是授权凭据**；最终可信依据是宿主已持久化、受不可变约束保护的真实记录。

`PreparedProjectSource` 已在内部增加宿主来源指针：`{ version, storageRealmId, uploadId, uploadDigest, preparedDigest, normalizationParserVersion }`。公开 foundation v1 命令仍只传现有 [sourceUpload](../packages/contracts/src/plugin-project-foundation-service.ts#L83) 的 `{uploadId, fileDigest}`；source 领域 v1 形状不扩大。actor 可以不同但 principal / tenant / space 必须相同，因此同一用户的 UI 上传能被其 Agent 采用。realm 不同的桌面/云端不能静默引用本机上传，须在目标宿主重新放置字节。

## 4. 解析、PDP 和同事务提交

解析流程：完整原片读取 → 顺序 / 长度 / 每片摘要 / 实际 whole digest 验证 → raw-sealed CAS → 事务外调用现有 parser → prepared 数据持久化并检查原 sealed 指针 → ready CAS。每个状态仅在 durable commit 后确认；确认丢失时通过原键或 GET 判定事实，不重新发送业务操作。任何客户端 manifest 都不能替代实际字节检查。

PDP 分两个目的，不能从 owner 或上传成功推导项目写权限：

- 原文上传使用独立 `ProjectSourceUploadAuthorizationPort`，显式动作 begin / writePart / readStatus / prepare / cancel，资源含 owner、真实 upload 身份和当前宿主安装资格；开始前、每片写入前、prepare 前和提交前重查当前授权。
- 采用到项目时继续使用既有 `creativeProject:create / write` 和 foundation plugin commit qualification；额外验证所选真实 upload 的 scope、ready 状态和当前可采用权限。新增项目在校验 upload 后原子写入，不先调用旧 createProject。更新项目要沿原 archive/CAS 锁，归档后不得继续追加 source。

提交边界：

1. 仍优先按原命令摘要查已有 foundation receipt。已成功提交的 replay 不读取 raw bytes、不依赖未提交上传 TTL，不再解析或关联另一个项目。
2. 新提交在 **foundation Store 的现有事务连接** 查真实 ready ledger：完整 owner / realm / upload 指针 / parser version / fileDigest / byteLength / fileName / format / 规范摘要、正文块和章节 root 全部一致。禁止在该事务里调用独立上传 Store 公共方法、重新借连接、读文件、解析 HTML、HTTP 上传或调用模型。
3. Store 以 ledger 的实际规范数据写项目专属 source/chunks/chapters，或逐块验证 prepared recipe 与实际 ledger 一致；不能只检查 DTO 的 `fileDigest` 格式或相信调用方提供的 `preparedDigest`。同事务写 foundation/source、multiuse association 和 immutable mutation receipt，失败全部回滚。
4. SQLite 延续 [BEGIN IMMEDIATE + 同步最终 active check](../packages/store/src/project-foundation-sqlite-store.ts#L688)；异步外部 PDP 在事务前，事务内资格查询用当前 `DatabaseSync`。Postgres 延续 [原 project advisory lock](../packages/store/src/project-foundation-postgres-store.ts#L334) 和 [同一 pool client 的最终资格/COMMIT](../packages/store/src/project-foundation-postgres-store.ts#L771)。解析和真实字节复制不占用该连接；外部 PDP callback 不借正在提交的 parent pool，覆盖 max-pool=1。
5. GC 与 association 提交使用一致的锁：PG 先原项目锁，再 owner/upload 锁；GC 只取 upload 锁、不反取项目锁；SQLite BEGIN IMMEDIATE 统一串行。提交在锁内复查 ready / retention，GC 必须在同一锁内复查无关联，防止读取后被删除。
6. 提交前撤权阻止入库；确认 COMMIT 后准确返回原事实，不因响应发送时撤权改称失败。业务确认丢失时恢复原 receipt，不能重新分配 projectId 或再次发起 Run。

UI 确认顺序：上传 ready → 用户确认创建参数 → stage 小型 foundation intent → dispatch 原 foundation 命令 → receipt accepted。上传/prepare 超时、缺片、编码错误和容量失败期间不 stage / dispatch 项目创建；已有 uncertain foundation intent 必须先恢复原键。刷新或 mount 更新时可从宿主读取上传状态，保留 owner/realm 隔离，不在本地日志中保存整本原文。上传成功也不自动启动任何 Agent、模型或供应商工作流。

## 5. 上限、错误反馈与 GC

原字节和规范 UTF-8 正文**分别**不得超过 `20_000_000` 字节。[parser:56](../packages/media-runtime/src/project-source-import.ts#L56) 已检查规范正文上限，UTF-16 原文件虽然小于 20 MB，转 UTF-8 后仍可能超限；不能截断保存或分块后规避总限。对用户明确说明“原文件 / 转换后的正文超过 20,000,000 字节”，并提供可取消/重新选文件的状态。编码、空正文、格式伪装、HTML 结构预算和摘要冲突也给稳定公开错误；不暴露服务器路径、数据库异常或正文片段。

以下保留窗口是建议的初始配置，不是已上线默认值：

- receiving / raw-sealed / 中断 preparing：24 小时不活动后可过期；有效解析 claim 内不 GC。失败和取消可立即清理未采用的 raw payload；保留小型终态 tombstone 和原键，重试明确返回原状态，不把 cancelled/expired 复活成新上传。
- ready 但从未关联项目：至少保留 7 天；过期前有明确时间和续期/重新上传反馈。不要把整个数据库的项目成果一并清理。
- 关联到任意项目：保留上传身份、封存证明、prepared canonical 数据和 multiuse 关联，用于以后把同一原文导入其它独立项目；raw payload 可按独立保留期限清理，但片的位置/长度/摘要描述和 ready 证明保留，采用新项目无需重新取得已清理 raw bytes。
- 已提交项目的 source / chunks / chapters / 关联 / receipts 长期保留，归档项目不是删除原文。不得用上传 TTL 删除这些事实；后续删除必须另有显式数据生命周期设计。
- 存储容量用 owner 维度限额、并发上传/prepare 限额和 host 总预算拒绝，不能靠删除 pending intent 或历史成果腾空间。界面只显示进度、可恢复动作和实际错误；不要再次添加“任务与连接”技术面板。

## 6. 下一阶段准确文件范围

新增模块建议按职责分开，每个保持小于约 800 行：

| 层                       | 新增文件建议                                                                                                                    | 需适配的既有入口                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| domain                   | `packages/domain/src/project-source-upload-{types,validation,state}.ts` 及行为测试                                              | domain index；不修改 CreativeProject v0 / ProjectSource v1                                                                                                                                                                                                                                                                                                                                                                            |
| application              | `packages/application/src/project-source-upload-{store-port,authorization-port,commit-authority,application-service}.ts` 及测试 | [project-source-preparation-port.ts](../packages/application/src/project-source-preparation-port.ts)、[project-foundation-store-port.ts](../packages/application/src/project-foundation-store-port.ts)、[project-foundation-application-service.ts](../packages/application/src/project-foundation-application-service.ts)；只扩内部 ledger proof                                                                                     |
| store                    | `packages/store/src/project-source-upload-{schema,store-support,sqlite-store,postgres-store}.ts` 及真实双后端测试               | [foundation SQLite](../packages/store/src/project-foundation-sqlite-store.ts)、[foundation PG](../packages/store/src/project-foundation-postgres-store.ts)、[sqlite-extension-composition.ts](../packages/store/src/sqlite-extension-composition.ts#L47)、[SqliteRunStore](../packages/store/src/sqlite-run-store.ts#L755)、[PostgresDomainStore](../packages/store/src/postgres-domain-store.ts#L246)；显式迁移、借原数据库连接/pool |
| media-runtime            | `packages/media-runtime/src/project-source-upload-preparation-adapter.ts` 及测试                                                | 调用 [project-source-import.ts](../packages/media-runtime/src/project-source-import.ts)，绑定宿主 ledger；不调整现有 parser 规则                                                                                                                                                                                                                                                                                                      |
| contracts / SDK / client | [独立上传合同](../packages/contracts/src/project-source-uploads.ts)已实现；HTTP注册、SDK/client与UI服务声明待接线               | [plugin-sdk/ui-types.ts](../packages/plugin-sdk/src/ui-types.ts)、[control-api.v1.json](../packages/contracts/openapi/control-api.v1.json)、control-client 入口；生成类型按现有工具生成，不手改 generated；保持旧 JSON invoke 和 foundation v1 请求不变                                                                                                                                                                               |
| Control 宿主             | `apps/control-api/src/project-source-upload-{route,control-owner,composition}.ts` 及 integration 测试                           | [control-api.ts](../apps/control-api/src/control-api.ts)、[production-plugin-ui-request-service.ts](../apps/control-api/src/production-plugin-ui-request-service.ts)、production / desktop composition、真实 identity / PDP / activation / storage admission                                                                                                                                                                          |
| 网页与桌面 transport     | `apps/crewon-ui/src/lib/plugins/installedPluginSourceUploadTransport.ts` 与恢复控制器                                           | [trustedPluginUiLoader.ts](../apps/crewon-ui/src/lib/plugins/trustedPluginUiLoader.ts)、[controlPluginUiHost.ts](../apps/crewon-ui/src/lib/plugins/controlPluginUiHost.ts)、[desktopPluginUiHost.ts](../apps/crewon-ui/src/lib/plugins/desktopPluginUiHost.ts)；沿原 ControlApiClient，不改 desktop HTTP v2 limit                                                                                                                     |
| BFF                      | `apps/web-bff/src/project-source-upload-proxy-policy.ts` 及测试                                                                 | [plugin-proxy-policy.ts](../apps/web-bff/src/plugin-proxy-policy.ts)、[web-bff.ts](../apps/web-bff/src/web-bff.ts)：显式 route / raw content type / 有界 reader / response 校验，不扩全局预算                                                                                                                                                                                                                                         |
| 插件与恢复               | 短剧项目创建上传控件和小型 foundation journal 恢复入口                                                                          | examples/plugins/short-drama 当前 UI；扩小型 intent action allowlist / payload verifier / host-service availability 时做旧包兼容测试，不更换 Agent 对话框                                                                                                                                                                                                                                                                             |

上述文件列表是下一阶段实施范围建议，不代表这些新文件/路由/宿主服务已经存在。proposal text 继续沿既有有界方案命令（8,192 UTF-8 字节），**不经过原文上传通道**；小说章节不等于产出的集数，上传日志不负责大纲生成、方案确认或模型执行。

## 内部采用实现与正式入口的区别

[准备桥接](../packages/application/src/project-source-upload-foundation-adapter.ts)调用实际上传业务服务；来源指针只进入内部Store参数，公开请求仍仅包含uploadId/fileDigest。创建采用projectId=null，追加使用真实已有项目ID，不借原文件名或UI缓存推导身份。

[共同证明](../packages/store/src/project-foundation-source-adoption.ts)在写事务前计算正文块/章节描述根。[SQLite](../packages/store/src/project-foundation-sqlite-source-adoption.ts)与[Postgres](../packages/store/src/project-foundation-source-adoption-postgres.ts)借用原项目事务，检查当前realm、同owner上传、不可变initial/parts/seal/prepared/latest event、ready状态及实际持久化块/章节描述；PG沿原project锁再取得原upload锁，不借第二个pool连接。核对通过后，原项目/source/association/receipt在一次COMMIT中发布。缺失凭证默认拒绝，旧内部解析配方夹具显式使用trusted-internal-recipe。

来源指针只证明数据关联，不代表当前权限。独立upload:adopt的Current/Active回调必须与项目Current/Active及安装事务资格一起复核；正式组合不合成UI pin、不把owner相同作为授权。该回调及真实双库撤回/确认提交行为已在[实际采用集成](../apps/control-api/src/project-foundation-source-upload.integration.test.ts)通过14项、零跳过，含独立采用权限在关联SQL写入后撤回全回滚、真正COMMIT成功后撤回仍返回事实。已有项目receipt重放先于临时上传读取，不重新解析、重新生成项目ID或关联另一项目。

这些是内部业务与持久化实现，尚未注册本文建议的公开上传路由、SDK服务或短剧页面；不能把内部集成通过称作用户导入已可用。GC仍未执行，保留期是待实施设计。

新增独立 `@crewon/contracts/project-source-uploads`：begin/status/prepare/cancel JSON不超过8KiB；状态/结果不超过60KiB，最多306片描述，不含realm/owner/parser/claim/provenance或正文。raw分片定位与规范URL路径独立校验，明确拒绝把bytes/base64放入小型JSON。20项行为和真实ES2022/noDOM/types[]公共声明编译测试通过。这个合同不扩全局body limit，不代表路由或SDK已经可调用。

## 7. 实施顺序与验收

先落 domain / internal ports / 双后端 journal 和 immutable manifest，再接原 parser 的 host adapter，然后加 foundation 同事务关联和 receipt 行为，最后加 SDK / client / BFF / 两端 host upload UI 与小型命令恢复。只有真实两端和业务恢复用例完成后，才声明“用户可导入小说并继续创作”。

最少验收：

- 真实 20,000,000 字节 Unicode 文件跨 raw 片切断 UTF-8 / UTF-16 单元后重组解析；单片/整文件实际摘要、字符偏移与 chapter 偏移正确，原文和规范正文各自超限拒绝。
- 缺片、重复相同片、相同 index 不同内容、错 offset、过长片、错误 total/fileDigest、乱码/空正文/格式欺骗和 HTML 实体；不漏存、不覆盖、不执行资源。
- 断网、失联 ACK、进程重启、mount 续期和重开后恢复同一个上传；准备错误不创建项目，不进入 uncertain 项目 dispatch。
- 伪造 prepared DTO / realm / owner / ledger digest / parser version / file metadata / chunk / chapter 拒绝；一个真实 ready upload 成功关联两个独立项目，修改一项目不改变另一个。
- SQLite / PG 均覆盖真实大文件持久化、同事务回滚、重复原 key、不同请求原 key冲突、并发 append/CAS、先归档后采用、GC 与 association 竞争和 pool=1。
- 提交前 PDP / 安装资格撤回拒绝；确认 COMMIT 后撤回仍准确返回已提交事实；删除临时 raw payload 后业务 receipt 重放及再次关联另一项目成功。
- 实际网页 BFF 和打包桌面 main-process HTTP 用同一协议 raw bytes，64 KiB 切片，错误 Content-Type / CSRF / origin / 未声明能力失败；旧插件、旧宿主和原 UI/会话功能保持兼容。
- Agent / UI / recovery JSON 不含 raw/base64/整本正文；正文详情只走已有有界 source-page/chapter-index 读口。
