# W1-09 Specification: Artifact、Audit、Trace 与 Retention

## 1. 目标

W1-09 建立所有消费者可复用的最小产物与审计语义：

1. `ArtifactRef/Manifest` 只描述不可变版本、来源、内容 Hash、媒体类型、敏感级别、验证状态和 Retention。
2. `EvidenceRef/CitationRef` 只引用真实 Artifact、Audit Event 或 Resource revision，不保存模型生成的“看起来像证据”的正文。
3. `AuditEvent` 只保存结构化事实、Trace/Cost、关联引用和可选 PayloadRef；不保存 Secret、原始 Tool arguments/result 或无限 Context。
4. Payload 正文进入可删除 Store；删除后保留 tombstone、Hash、大小和审计元数据。
5. Store 复用现有 `StateRuntime` 与 `state_5.sqlite` 生命周期，不创建第二数据库。

本阶段不注册 v2 RPC、不修改旧 Office artifact、Task event 或 UI；W1-10 负责 composition，消费者在各自切换 Wave 原子迁移。

## 2. 当前真实入口与问题

- `office/artifact/upsert` 接收 `cwd + config + JsonValue artifact`；inline `content/body/text` 会被移除并留下 SHA-256/bytes，但客户端仍可提交 title/path/url/meta，且没有不可变 revision、服务端 actor/workspace、Retention 或 delete semantics。
- Office manager structured output 仍将 artifact 作为宽松 JSON 写入 Office config。
- Task Runtime event/outbox 仍保存 bounded JSON 字符串；新消费者尚未建立“大正文只进 Payload Store”的强类型入口。
- `state/src/audit.rs` 是线程数据库诊断查询，不是产品 Audit Event authority。
- Trace/usage 分散在 Thread/Core/Provider 路径，没有跨 Artifact/Approval/Resource 的最小共享引用。

## 3. 模块和依赖边界

新增纯领域 crate `crewon-artifact`：

- 依赖 `crewon-task-runtime`、`crewon-resource-federation` 和 `crewon-policy` 的稳定引用。
- 不依赖 UI、HTTP、SQL、app-server 或 Core。
- Payload body 不实现 Serialize，Debug 只显示 redacted byte count。

扩展现有 `crewon-state`：

- 新 migration 在 `state_5.sqlite` 增加 payload、manifest 和 audit event 表。
- State DTO 只接受 bounded bytes/JSON/reference metadata，不暴露领域 reducer 或 UI 类型。
- create manifest + payload + audit event 使用一个 `BEGIN IMMEDIATE` 事务。

app-server `platform_control` adapter：

- actor/tenant/space 从 `RequestIdentity` 派生。
- Workspace correlation 从已解析 `WorkspaceRef` 派生。
- 下游提供 Task/Conversation、Resource、Approval 和 Trace 的服务端引用；不从客户端接收路径或 owner。

## 4. Artifact 与 Payload

### 4.1 Artifact Manifest

Manifest 固定：

- schemaVersion；
- artifactId + positive revision；
- kind；
- exact PayloadRef：payloadId、`sha256:<hex>`、byte length、media type、sensitivity；
- producer actor；
- Workspace key/binding/scope；
- Conversation 或 Task/Run/Attempt correlation；
- Provider/Resource revision correlation；
- Approval decision correlation；
- Trace context；
- verification status；
- retention policy；
- createdAt。

Manifest 不包含 title、path、URL、正文、环境变量、Credential value 或自由 JSON metadata。未来用户可见标题属于 projection/payload，不进入审计核心。

### 4.2 Payload body

- 第一版 State Store 单 payload 最大 8 MiB；0-byte payload 允许。
- body 只在 create/read 边界短暂存在，不进入 Artifact/Audit Serialize、Debug 或错误。
- Public/Internal/WorkspaceSensitive 可进入本地 SQLite BLOB；Secret 在未实现加密 store capability 前 fail-closed。
- content SHA-256 在领域层与 State adapter 双重校验。
- downstream 只持有 PayloadRef，不持有 SQLite row 或文件路径。

## 5. Evidence、Citation、Trace 和 Cost

- `EvidenceRef` source 只能是 exact ArtifactRef、AuditEventRef 或 ResourceRef，并声明 observed/verified/rejected。
- `CitationRef` 绑定 EvidenceRef 和 bounded locator；不复制引用正文。
- `TraceContext` 固定 traceId/spanId，可选 parentSpanId；ID bounded，root/child 使用命名构造器。
- `UsageCost` 使用整数 input/output tokens、tool calls、amount micros 和 currency code；不使用 float。
- Audit 的 Resource/Approval/Cost/Payload 关联均使用显式 enum `None | Reference`，不靠 nullable 字段猜测。

## 6. Audit Event

Audit Event 固定：

- eventId、idempotencyKey、schemaVersion；
- server-derived actor/workspace；
- Conversation 或 Task/Run/Attempt correlation；
- action enum 与 outcome enum；失败只记录 bounded error code，不记录原始错误正文；
- Trace/Cost；
- Provider/Resource、Approval decision、Artifact refs；
- 可选 PayloadRef；
- occurredAt。

第一版 action 至少覆盖 artifact created/read、payload deleted、retention expired、policy evaluated、approval decided、external action。Artifact refs 数量有硬上限。

W2-05 production execution journal 接入前必须对 outcome 做 additive amendment：增加带 bounded errorCode 的 `unknown`，用于 timeout、transport ambiguity 或 completion durability failure。不能把未知副作用伪记为 failed/succeeded；在 Artifact domain 与 State schema 同时 Green 前，Dynamic Tool Audit adapter 保持 Gate Red。

## 7. Retention 与删除

RetentionPolicy：

- `session { expiresAt }`
- `task { expiresAt }`
- `userManaged`
- `compliance { expiresAt }`

规则：

- Session/Task/Compliance expiry 必须晚于 createdAt。
- 用户清理允许 Session/Task/UserManaged；Compliance 只能由 tenant compliance、Provider withdrawal 或 authority policy 删除。
- 删除不删除 manifest/audit row；payload row 进入 deleted tombstone，content 置 NULL，记录 deletion reason/time。
- State DB 对 payload 表启用 SQLite `secure_delete=ON`；删除事务后执行 WAL truncate checkpoint。若 checkpoint 被并发读者阻塞，调用返回错误并允许同一删除请求安全重试，避免把“逻辑删除”误报为物理清除完成。
- 过期清理采用 bounded batch，幂等重复执行。
- 删除后 `read` 返回 manifest + deleted payload metadata，不返回正文。

## 8. 幂等与一致性

- Artifact create 使用 idempotencyKey；完全相同重试返回 existing，字段或 content 不同返回 conflict。
- Audit append 使用独立 idempotencyKey；相同事件幂等，不同事件 conflict。
- payloadId、artifactId+revision、eventId 和两个 idempotencyKey 均唯一。
- Artifact commit 的 payload、manifest、created audit event 原子提交；中途失败不留半个 artifact。
- restart 后 idempotency、deleted tombstone 和 audit metadata 保持。

## 9. 安全不变量

1. Secret/credential/raw arguments/raw tool result 不进入 manifest/audit/event JSON。
2. 大正文不进入 Task event/outbox 或 Audit metadata；只进入 bounded Payload Store。
3. UI/模型不能声明 actor、Workspace、verification 或 approval authority。
4. Payload 删除后 Hash/size/reference 可审计，但正文不可恢复。
5. 下游通过 stable refs 访问，不依赖数据库、绝对路径或 Office JSON shape。
6. 所有 ID、字符串、JSON、payload、artifact refs 和 cleanup batch 均有硬上限。
7. Manifest/Audit JSON 使用 schemaVersion 和递归严格字段白名单；State 拒绝额外 metadata、敏感键、过深/过多节点和引用字段不一致。

## 10. 非目标

- 不迁移旧 Office artifact，不修改 Office JSON 或旧 path/url 行为。
- 不把现有 Task event_json/outbox payload_json 自动改写为 PayloadRef；W1-10/W2 mapper 必须显式接入。
- 不实现云 Blob Store、KMS、签名 URL、全文搜索、UI 或 artifact RPC。
- 不保存 Secret payload；加密 store capability 需独立 SDD。
- 不创建通用 observability backend 或第二 Trace 系统。

## 11. 验收

- Domain Harness 覆盖 manifest/audit bounds、Evidence/Citation refs、Secret rejection 和 serialization redaction。
- State Harness 覆盖 atomic create/read/delete/expiry、idempotency、conflict、bounded cleanup 与 restart。
- 删除后 audit/manifest 仍存在，payload content 不存在；序列化与 DB 扫描不含测试 Secret/raw Tool payload。
- app-server adapter Harness 证明 actor/Workspace 来自服务端对象。
- targeted artifact/state/app-server tests、Bazel lock、scoped fix、final fmt 通过。
