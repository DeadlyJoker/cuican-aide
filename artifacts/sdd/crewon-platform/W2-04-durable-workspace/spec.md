# W2-04DW Specification: Durable Workspace Root Identity

状态：Discovery、State kernel 与 authenticated-only app-server adapter 已完成；W2-04 Provider/Resource API 可以进入实现，但 production Gate 仍关闭。

## 1. 问题与必要性

Authenticated Principal 已使 `actorId`、Tenant/Space 与 `CredentialOwner` 在受信重连后保持稳定；Agent Platform exact identity source、session revoke/freshness 与 RS256 issuer kernel 也已完成。但当前 `WorkspaceRegistry` 仍为 connection-session 生命周期：同一 server-configured canonical root 在每次连接和 app-server 重启后生成新的随机 `workspaceKey`。

这会使 durable Task、Provider Resource Binding 或 CloudWorker journal 中保存的 `workspaceKey` 在 app-server 重启后无法重新解析。直接开放 W2-04 会造成“Run 可恢复、Workspace 不可恢复”的半持久状态，因此必须先建立最小 durable root identity。

## 2. 最小终态

本切片只持久化 server-configured root 的不透明身份，不持久化 Workspace scope binding、权限快照或执行授权：

- app-server 继续从 `Config.cwd` 与 `effective_workspace_roots()` 获得唯一可信 root catalog；
- root canonicalize、目录/可读性和 symlink-safe path 校验仍由 app-server `WorkspaceRootCatalog` 拥有；
- app-server 对 canonical root 以明确的 OS-stable bytes（Unix 原始 bytes、Windows UTF-16LE）计算 domain-separated SHA-256 `rootFingerprint`，不依赖 Rust 未指定的 `OsStr` 编码；State 不接收或保存原始路径；
- State 将 exact `(nodeId, environmentId, rootFingerprint)` 映射为随机 `workspaceKey`，映射不可原地改指向另一 root；
- root 不在当前启动 catalog 中时，即使 State 存在记录也不可 list、bind 或 resolve；重新加入 server catalog 才可恢复同一 key；
- 只有 verified authenticated principal 可以消费 durable workspace key。Stdio、InProcess、legacy/capability WebSocket 与 RemoteControl no-principal 继续使用 connection-session key；
- `workspaceKey` 本身不是执行 Authority。后续 Resource/Task/Office 仍必须验证当前 principal、Tenant/Space、当前 catalog、binding scope、Policy、Credential 与 revision。

## 3. State record

新增内部表 `durable_workspace_roots`，字段仅包含：

- `workspace_key`：`workspace:<UUID>`，随机、opaque、全局唯一；
- `node_id`、`environment_id`：bounded server-owned identity；
- `root_fingerprint`：`sha256:<64 lowercase hex>`；
- `record_hash`：domain-separated hash，绑定以上 immutable identity 与 `created_at`；
- `created_at`：非负 Unix seconds。

数据库同时约束 `workspace_key` 唯一和 `(node_id, environment_id, root_fingerprint)` 唯一。相同 record 重放返回 existing；同 fingerprint 的并发不同随机 key 只能有一个 winner，loser 读取并返回 winner。读取时重新执行完整 validation/hash 校验；数据库篡改 fail-closed。表最多保留 1024 条 mapping；容量耗尽返回显式 `CapacityExceeded`，不覆盖、删除或复用旧 key。

## 4. 明确非目标

- 不保存 canonical root、相对路径、OS user、Secret、permission snapshot 或客户端 path。
- 不新增 v1/v2 RPC，不修改现有 `workspace/list`/`workspace/bind` shape。
- 不在本切片持久化 Workspace scope binding；W2-04 Resource Binding 只在后续 adapter 验证 stable workspace key 与当前 catalog。
- 不把 Workspace 模型放入 `crewon-core`，不新建数据库或服务。
- 不让 connection-scoped identity 获得跨连接 Workspace authority。

## 5. Harness 与验收

- Red Harness 先引用不存在的 durable workspace State types/runtime methods并编译失败。
- create/exact replay、close/reopen、相同 root 并发不同 key 单 winner、不同 root 独立 key、1024 条容量 Gate。
- 非 canonical key/fingerprint、超长 ID、负时间、hash mismatch 拒绝。
- 直接篡改数据库 fingerprint/hash 后读取失败。
- `just test -p crewon-state durable_workspace` 通过；State production module 低于 500 LoC，总非机械 diff 控制在 800 行内。

## 6. 下游 Gate

本切片已证明 authenticated reconnect 与 app-server/State reopen 复用同一 workspaceKey、当前 catalog 移除 root 后旧 key fail-closed、普通连接仍为 session random，因而解除 W2-04 Provider/Resource API 的 workspace prerequisite。W2-04 后续仍必须证明 subject/Tenant/Space change 不能复用旧 Provider/Resource owner；production key/config、真实云模型与 composition Gate 仍不得提前开放。
