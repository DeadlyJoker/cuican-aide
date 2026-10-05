# 插件文本冷恢复协议 v1

`crewon.project-text-recovery@1` 为 Short15 的四类手动文本写入保存已发送的完整意图。关闭或更换挂载后，用户可读取原请求、确认真实业务回执，或明确重试原动作。它是独立公共服务，保留冻结的 SDK 0.1.0、旧 UI invocation v1 和旧三类任务恢复协议，不创建 Run 或调用供应商。

## 公共入口

公共入口为 `@crewon/contracts/project-text-recovery`。`packages/contracts/src/plugin-project-text-recovery-service.ts` 是零 import 的 portable 文件，包含类型、服务常量和客户端；严格 codec 由同一公开入口提供。仓外插件可以携带字节一致的 portable 副本和公开 codec 的自持 ESM/声明文件，并在构建中固定两者 SHA-256。更新协议需要重新审阅 parser、重建公开 codec 并有意更新 pin，不修改冻结 SDK，也不导入宿主私有实现。

```ts
import {
  createPluginProjectTextRecoveryClient,
  projectTextRecoveryCodec,
} from "@crewon/contracts/project-text-recovery";

const recovery = createPluginProjectTextRecoveryClient(
  services, // 实际 SDK UI mount 提供的原 invoke 服务
  projectTextRecoveryCodec,
);
const { intent } = await recovery.getPending({ projectId }, { signal });
```

客户端不自动重试任何写入或 ACK。未知动作、未知版本和仅声明命名空间均不授予调用权限。

| 方法          | 精确动作                                      | 输入                                        | 响应                                                                |
| ------------- | --------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| `getPending`  | `crewon.project-text-recovery.v1.getPending`  | `{ projectId }`                             | `{ intent: null \| ProjectTextRecoveryIntent }`                     |
| `acknowledge` | `crewon.project-text-recovery.v1.acknowledge` | `{ projectId, intentId, expectedRevision }` | `{ intentId, revision, disposition: "acknowledged" \| "replayed" }` |

两项输入保留 **24 KiB UTF-8 JSON** 上限。`getPending` 只返回一条完整记录，整份响应最多 **60 KiB**，不返回多条大正文或截断原输入。原四类文本写入继续使用[共享文本 UI 协议](./plugin-project-texts-ui-protocol.md)的 60 KiB 输入预算；内容本身仍遵守大纲 16 KiB、剧本 32 KiB 的严格界限。

## 单条意图与真实确认

公开 intent 包含 `intentId`、CAS `revision`、`requestDigest`、`phase`、`request`、`confirmed` 和 `refusalCode`。`request` 是精确四动作的判别联合，保留完整原 `action/input`，包括原幂等键、正文、需求/大纲来源和预期成果 revision；不返回 actor、安装权威、完整 selection 或提交 grant。

| phase      | confirmed / refusalCode        | 可执行的下一步                                                    |
| ---------- | ------------------------------ | ----------------------------------------------------------------- |
| `pending`  | 两者均为 `null`                | 读取原输入；用户明确重试原动作、原正文和原键，不能 ACK 或换键发送 |
| `accepted` | 真实业务 receipt 摘要 / `null` | 读取确切修订及当前成果，呈现确认，再 ACK                          |
| `refused`  | `null` / 固定业务冲突码        | 呈现拒绝原因，明确 ACK 后重新编辑并建立新意图                     |

`confirmed` 仅包含 `{ kind, artifactId, artifactRevision, contentRevision, requestDigest, resultDigest }`。正文通过原 `getRevision/getArtifact` 读取，避免将原请求与完整写回执复制两遍。拒绝码仅允许 `project_text_revision_conflict`、`project_text_locked`、`project_text_dependencies_stale`、`creative_project_archived`；超时、连接丢失或权限撤回不构成业务拒绝。

每个实际 actor、完整安装来源和项目最多有一条未 ACK 意图。新键不会覆盖它。同键同输入返回原意图；修改正文、来源、预期 revision 或原键不能被解释为原请求重试。确认或拒绝后的 ACK 使用当前 intent revision；同一个 ACK 的回放返回原下一 revision，不再增加转换。终态记录保留为不可修改的已确认记录，不重新打开原 slot。

原写回执已经确认时，ACK 的丢失或失败不把业务改报为 UNKNOWN。UI 保留确认结果，读取 journal 后解决 ACK 状态，再允许新写入。关闭后的 `accepted` 也不能假装成尚未发送的草稿。

## 来源和事务资格

宿主显式配置 `textRecovery.publications`，且它必须是已批准 `textUi.publications` 的精确子集。声明服务或信任 Node 不隐式批准恢复服务；未批准的旧 Short14 保留原写入行为和不迁移 journal 的行为。

私有 scope 绑定实际 actor 的 tenant、space、principal、actor 四字段，安装的 tenant、space、profile、plugin、publisher、version、packageDigest、selectionRevision 八字段，以及实际 module contribution 和 projectId。当前挂载、账号/profile、UI policy、独立项目 PDP 和完整安装仍需重新核验。读取采用项目读权限；stage 和 ACK 采用项目写权限。

原四类真实文本动作在业务调用前自动 stage。宿主从实际 invocation WeakMap 捕获原 `crewon.project-text-plugin-commit.v1` 资格，附加实际 contribution 与服务器计算的 intent locator。locator 只定位 journal，不能授权写入；复制 context、自报 actor/安装或构造 Run 不能获得资格。

`getPending/acknowledge` 使用独立 `crewon.project-text-recovery-commit.v1` 资格，绑定它们自己的实际 action/input。它不能借用原四写、旧六项目动作或 Run 工具的事务资格。ACK 不能确认 `pending`，也不能通过另一个 actor、包版本、选择 revision 或 contribution 关闭原意图。

四类业务写入或合法同键重放在原文本 Store 的同一个数据库事务内，将实际业务 receipt 与 journal 的 `accepted` 引用/摘要一起确认；不会在业务 COMMIT 后另行制造 accepted。业务 receipt 身份、原命令、输入摘要与完整来源必须逐项一致。

安全 `refused` 必须在同一原 receipt 锁下核验没有已提交 receipt，并从实际项目/成果行证明冲突。已经提交则保留 `accepted`；否则写入 terminal fence，原请求即使随后到达或被其他入口复用也不能迟到 COMMIT。ACK 不移除这个终态约束。

PostgreSQL 使用已经借出的同一个连接检查真实安装、业务 receipt 和 journal，锁顺序与原业务写入一致；事务中的 profile/UI/项目 PDP 回调只做外部核验，不再次借父连接池。SQLite 在 `BEGIN IMMEDIATE` 外完成异步核验，事务内核验真实表、安装和原记录，并在 COMMIT 前同步检查 invocation/owner。实际表缺失、部分迁移、view 或 shadow schema 不能充当终态证据。已物理确认 COMMIT 的业务结果与 ACK 不被晚到的本地关闭改报为未提交。

## 恢复边界

本协议恢复已 stage 的完整写意图，不恢复用户尚未发送的编辑草稿。包升级、停用再启用、profile/actor 或选择 revision 变化会形成新的来源；新挂载不自动读取、代用或 ACK 旧 slot。旧记录不会因此被删除，也不会自动迁移或重新发送。

恢复读取不启动 Agent，不切换项目对话，也不代表已经完成项目聊天绑定、阶段 Agent 启动、其他媒体工作流或实际桌面安装交付。原宿主导航、账户入口、左右栏和全局 CSS 不因该服务改变；本轮未改实际 App/profile、本机网络或原未知 Krea operation。

## 验证证据

公共协议 Contracts 全量 **471/471**、Application 全量 **649/649**，零失败、零跳过；两包 typecheck、所拥有文件格式检查和 diff 检查均通过。包括真实 generic mount 的复制调用拒绝、四写 stage、原输入保留、独立项目 PDP、关闭物理 join、确认 ACK 后关闭以及显式批准子集。Application 的内存端口测试明确只证明该层调用资格，不替代数据库原子性证明。

隔离 Native SQLite/Production PostgreSQL HTTP 与旧兼容组合 **78/78**、Native 来源批准 **7/7**，零跳过；真实 `maxPoolSize: 1`、丢 ACK 后冷重开、原键回放、明确 ACK、跨包/actor 拒绝和四类写入均有数据库证据。原 Node peer、Run、funding、generation link、外部 operation 和供应商调用为零。

Store 最终真实 SQLite/PostgreSQL 专项 **26/26**、旧兼容 **39/39**，零跳过。包括 accepted 和已 ACK 原键不能通过普通 HTTP 读取回执、真正已准入 Run/Tool 也不能替代原 UI 来源资格、终态拒绝阻止迟到提交、同连接回滚及物理 COMMIT 后确认结果保留。

各组有重复覆盖，不能相加为独立总数。后续插件 UI 验收以最终证据为准，不使用预计测试数量。证据目录为 `output/extensions/checks/project-text-recovery-20261006/`，其中 `protocol-owner-verification.json` 和 `control-native-verification.json` 区分 Application 内存端口与实际数据库 HTTP 范围。
