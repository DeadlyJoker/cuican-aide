# 安装插件的创作项目动作协议

状态：已实现动作契约、可独立分发的 SDK helper 与每次调用的提交前检查。正式 Host dispatcher、依赖可用性投影、模块 ready 和页面保存仍待接线。定义协议或安装 SDK 不会使该服务自动可用。

项目公共服务见[公共元数据接口](./creative-project-public-service.md)。当前 kind 固定为 `short-drama`，归属仍是 tenant/space/principal；本协议没有增加 plugin/profile/package 数据隔离。

## 插件调用

协议名称为 `crewon.creative-projects`，API 为 `1`。动作使用现有 `PluginUiServices.invoke`，没有增加 UI ABI、清单字段或 Node 动作 kind。所有动作名加前缀 `crewon.creative-projects.v1.`：

| 动作                                                               | 输入                                              |
| ------------------------------------------------------------------ | ------------------------------------------------- |
| `listProjects`                                                     | `{ query }`                                       |
| `getProject`                                                       | `{ projectId }`                                   |
| `createProject`                                                    | `{ request, idempotencyKey }`                     |
| `renameProject`, `setProjectState`, `appendBrief`, `createConcept` | `{ projectId, request, idempotencyKey }`          |
| `getBrief`                                                         | `{ projectId, briefRevision }`                    |
| `listBriefs`, `listConceptAssets`                                  | `{ projectId, query }`                            |
| `getConceptAsset`                                                  | `{ projectId, assetId }`                          |
| `appendConceptRevision`                                            | `{ projectId, assetId, request, idempotencyKey }` |
| `getConceptRevision`                                               | `{ projectId, assetId, assetRevision }`           |
| `listConceptRevisions`                                             | `{ projectId, assetId, query }`                   |

查询使用 JSON 数字，分页规则和写请求 body 复用公共 HTTP 契约。输入最多 24KiB、响应最多 60KiB，列表最多 50 项。公开 DTO 没有 owner、凭据、付款方或执行身份，插件不能在输入中注入这些字段。概念资产 ID 与输入修订号分别传入，不能把修订号当成资产 ID。

SDK UI 入口提供类型化的 14 个方法：

```ts
import { createPluginCreativeProjectClient } from "@crewon/plugin-sdk/ui";
import type { PluginUiServices } from "@crewon/plugin-sdk/ui";

export async function saveBrief(services: PluginUiServices) {
  const projects = createPluginCreativeProjectClient(services);
  return projects.createProject({
    request: { title: "雨夜来信", briefText: "围绕一封迟到的信展开故事。" },
    idempotencyKey: "create-project-1",
  });
}
```

helper 捕获同一个 dispatcher 和 caller signal，取消后拒绝迟到结果并清理监听。取消不能证明数据库已经回滚；保存响应丢失时，重试须保留原幂等键与原输入。helper 不签发权限，不判断服务是否已启用，也不负责 Host ready。

## 宿主提交前检查

可信 Host 可对实际 `PluginUiApplicationService` 注册的本次 context 调用 `capturePluginUiInvocationCommitAuthority`。发行器只接受确切、仍注册且包含同步检查的 context，不能用 JSON、对象拷贝或旧 context 获得权限。普通 SDK 不导出此能力。

Application 的六个写用例及 Store 的四种提交支持独立的可选 `CreativeProjectCommitOptions`。Host 在调用中传入 `{ authority }`，不把回调放入输入、持久回执或 HTTP body。缺省时保留原公共服务行为。Application 在授权和持久读取后的异步边界复验，Store 再核对实际提交资格。

SQLite 在 BEGIN 前做异步授权检查，事务内部保持同步，实际写入及 COMMIT 前执行同步检查。PostgreSQL 在全部 SQL 和回执写入后再次异步核对，随后同步检查并立即派发 COMMIT，中间没有 await。关闭、过期或已经观察到的明确撤权会拒绝尚未派发的提交，整笔事务回滚，包括幂等回执；重放也检查本次资格。同步检查必须返回 `undefined`，Promise 或 thenable 不能推迟检查。

此边界保证 COMMIT 派发前已观察到的撤权生效，不保证远端授权策略与数据库之间有全局原子性。已确认 COMMIT 不因后来撤权而改成保存失败，原回执仍可由当前合法调用恢复。

## 后续接线门槛

Host 仍需显式核验真实包、贡献、模块启用与实际依赖可用性，再把这些 metadata 动作接入 dispatcher，复用当前真实用户身份和项目授权。UI-only 包不能通过伪造 Node 服务绕过安装限制。已有任务动作和 committed-task 交付语义必须保留。

模块 mount 时应等待实际激活 ready；当前 staged mount 不允许调用，不能用微任务延迟猜测就绪。普通 JSON 动作仍执行原交付后检查：若保存已确认、页面随后关闭，响应可能被拒绝，本轮测试证明原回执可以恢复，但尚未实现专用 committed-metadata 交付。

正式页面保存、项目生成与原 Run/个人积分冻结的同事务关联、已核验结果选用、生产身份与钱包及真实供应商验收仍未完成。该协议只扩展模块能力，保留原用户栏、设置和侧栏样式。
