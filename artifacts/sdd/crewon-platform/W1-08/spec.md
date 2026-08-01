# W1-08 Specification: Policy、Approval 与 Action Digest

## 1. 目标

W1-08 建立本地和未来 Cloud Authority 可共同复用的纯领域安全边界：

1. `PolicyDecision` 只有 `allow`、`deny`、`approvalRequired` 三种结果。
2. `Approval` 绑定不可变、版本化的 `ActionDigest`，执行前按当前动作重新计算并逐字段比较。
3. Approval 只能消费一次；重复审批、重复请求保持幂等，nonce 重放和重复消费被拒绝。
4. Approval 状态可序列化、校验并恢复，但本阶段不创建第二数据库；W1-10 负责组合到既有 Authority/State。

本阶段只建立领域 crate、服务端 adapter 和 Harness，不注册 RPC、不切换 Core Tool approval、Office approval 或旧执行器。

## 2. 当前真实入口与问题

- Core `AskForApproval`、command/file/permissions approval 是 Thread/Turn 内部的执行权限交互，仍由 Core permission profile、sandbox 和客户端回调管理。
- `office/approval/decide` 当前接收 `cwd + config + approvalId + decision`，在客户端提供的 JSON 中写入 `decision`；没有 actor、Workspace、资源 revision、参数、Credential、expiry 或 nonce 绑定。
- `WorkspaceRef`、`RequestIdentity`、Credential 生命周期和 Resource Binding 已由 W1-01/W1-02/W1-03/W1-04 建立，但尚无统一动作授权模型。
- canonical v2 `ApprovalRef` 只有安全引用字段，不代表审批状态机或执行凭证。

因此不能把 UI 是否点击确认、Office JSON 的 `decision`、自然语言摘要或 Provider 的返回文案当作执行授权事实。

## 3. 所有权与模块边界

新增独立 `crewon-policy` 领域 crate：

- 不依赖 UI、HTTP、SQL、app-server 或 `crewon-core`。
- 复用 `crewon-resource-federation` 的 `WorkspaceKey`、Provider/Resource revision 与 `ExecutionLocation`。
- 只保存 Credential 的安全引用快照，不依赖 Secret Store，也不接触 Secret。
- 公开不可伪造的 `ExecutionAuthorization`：只有即时 `allow` 或已批准动作成功消费后才能得到。
- 即时 authorization 的 approvalId 为 none；consumed approval 产生的 authorization 必须携带 exact approvalId，供后续 metadata-only Audit 建立 ApprovalCorrelation，不能用 accessDecisionId 反推。

app-server `platform_control` adapter：

- actor、tenant、space 从 `RequestIdentity` 派生。
- Workspace key、binding、scope、node、environment 从已解析 `WorkspaceRef` 派生。
- target、Credential snapshot、purpose、arguments、side effect 与 expiry 必须来自后续服务端 resolver；本阶段 adapter 不暴露 RPC。

## 4. Action Intent 与 Canonical Digest

### 4.1 必须绑定的字段

`ActionIntent` 至少包含：

- schema version；
- action type；
- actor、tenant、space；
- bounded purpose；
- workspaceKey、bindingId、scope、scopeId、nodeId、environmentId；
- Tool / Provider / Resource identity 与 exact revision；
- canonical JSON arguments 的 SHA-256；
- Credential ref：`none` 或 credentialId、providerId、status、revision、expiry；
- executionLocation；
- side-effect classification；
- expiresAt；
- nonce。

`none` 是显式 Credential variant，不用含义不清的 nullable 表示。存在 Credential 时，非 Available 状态必须 `deny`；rotate/revoke/expiry/status 变化都会改变 digest 或阻止执行。

### 4.2 Canonical encoding

- JSON object key 递归排序；Array 顺序保留；Number/String/Boolean/Null 保持 JSON 类型。
- 原始 arguments 不进入 Digest payload，只保存 canonical arguments SHA-256。
- Digest domain separator 固定为 `crewon.action-digest.v1`。
- 输出固定为 `sha256:<64 lowercase hex>`。
- canonical fixture 固定完整 payload 和最终 digest；任何字段名、enum tag、optional 语义或排序漂移必须让测试失败。

## 5. Policy Decision

第一阶段只实现必要的安全基线，不创建动态策略语言或插件 Registry：

- 动作已过期、Credential 非 Available：`deny`。
- Read-only：`allow`。
- Local mutation、external write、send、publish、delete、destructive：`approvalRequired`。

后续消费者可在服务端 resolver 前增加更严格的 deny 规则，但不得把 `deny` 降级为旧执行器 fallback。`accessDecisionId` 只做 CrewON 审计关联；Provider 必须再次校验自身资源授权。

## 6. Approval 状态与幂等

状态：

```text
pending -> approved -> consumed
pending -> denied
pending | approved -> expired
```

规则：

- `approvalId` 重复且完整请求相同：返回同一记录，不新建副作用。
- `approvalId` 相同但内容不同：conflict。
- nonce 已被其他 approval 使用：replay。
- decide 必须匹配 server-derived owner 与 ActionDigest。
- 重复相同 decision 幂等；冲突 decision 拒绝。
- consume 必须重新计算当前 ActionDigest，并再次检查 owner、expiry 与 Credential 状态。
- consumed approval 永远不能再次产生 `ExecutionAuthorization`。
- snapshot restore 校验记录数上限、ID/nonce 唯一性、状态与时间形状；损坏状态 fail-closed。

## 7. 安全不变量

1. UI 状态、自然语言摘要和 Provider 文案都不能构造 `ExecutionAuthorization`。
2. actor、tenant、space 和 Workspace 不从 Client Params 读取。
3. arguments 使用 canonical JSON hash，key 顺序变化不触发假差异，值或 Array 顺序变化必须失效。
4. actor、purpose、Workspace、target revision、Credential、executionLocation、side effect、expiry 或 nonce 任一变化都失去批准。
5. Approval 只解决 CrewON Gate；Provider 自身授权不可省略。
6. Snapshot、Debug、错误和 fixture 不保存 Secret 或原始 arguments。
7. 所有字符串、记录数和时间均有硬边界；没有无界 map/vector。

## 8. 非目标

- 不修改 `office/approval/decide`、Core command/file approval、permission profile 或 sandbox 行为。
- 不新增 `approval/*` RPC；W1-10 负责 composition，W3 负责 Office 原子迁移和旧路径删除。
- 不创建通用规则 DSL、动态策略插件、远程 Policy Service 或第二数据库。
- 不实现 Provider 资源授权、Tool Bridge、Artifact/Audit；分别属于 Provider、W2/W6 和 W1-09。

## 9. 验收标准

- stable ActionDigest fixture 通过。
- 逐字段 mutation 矩阵全部产生不同 digest 或明确 deny。
- 覆盖 canonical arguments、过期、nonce 重放、owner mismatch、跨 Workspace、Credential rotate/revoke、target revision。
- 重复 approval request/decision/consume 不产生重复执行权限。
- serialize/restore 后仍不能重复消费。
- app-server adapter 证明 actor/Workspace 来自服务端已解析对象。
- targeted Rust tests、Bazel lock、scoped fix、final fmt 通过；完整 workspace test 仍需用户批准。
