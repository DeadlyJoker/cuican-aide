# F01 Worker 交付工具证据

日期：2026-09-14。实现位于独立 F01 worktree；本子任务未提交、未 push。

## 实现与边界

- `delivery-tool-runtime.ts` 暴露 `delivery_catalog/read/assemble/patch`。任务、租户、空间和 owner 从实际执行命令关联的 Run/Thread 解析；不接受模型声明路径、threadId 或 sourceRunId。
- 读工具为 readOnly/replaySafe；保存与修改为 mutation/reconcilable/perAction。恢复使用真实 invocation.idempotencyKey，交给 application 的持久事务幂等与版本 CAS。
- 工具目录和内容逐页输出，最大 9 KiB UTF-8；350 张工作表可逐页完整发现。无法容纳的一行明确失败，不截断单元格。
- 交付文件写入 `.delivery.sqlite` 独立加密库；toolOutput/retention 语义未改。standalone 仅在 artifact 配置完整时装配；production/Postgres 不隐式打开本地交付库。release 和运行时使用同一工具定义，历史 AgentVersion 继续按原目录筛选。
- `delivery-composition.ts` 的 `createDeliveryDownloadImporter` 为 F05 提供真实 bytes 接口；`configureDeliveryDownloads` 安装的 importer 复用同一个 application/store。当前只验证这个适配器，尚未验证 F05 真实浏览器调用。

## 已运行检查

| 检查                                             | 结果                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| `pnpm crewon:boundary:check`                     | 通过，TypeScript 边界有效                                           |
| `pnpm --filter @crewon/runtime-worker typecheck` | 通过                                                                |
| `pnpm --filter @crewon/runtime-worker test`      | 494 tests：448 通过、46 跳过、0 失败；包括 license check            |
| delivery 三个新增测试文件定向重跑                | 10/10 通过                                                          |
| standalone composition 新增两项                  | 已包含 Worker 全量结果，启用目录/真实 store 一致，缺 store 拒绝启动 |

跳过项为现有可选环境用例，包括未配置的 Postgres；这些不是交付生产远程存储证据。

## 真实文件与恢复

`delivery-worker-recovery.test.ts` 使用真实 Worker、真实 SQLite Store、真实 SpreadsheetEngine，以及真实 HTTP/SSE 传输上的脚本模型响应。它从两个 CSV 与第四张 XLSX 工作表处理七条合成记录（10、20、30、40、50、60、7），写入上传的 XLSX 模板：

1. 实际 perAction approval 后持久化文件；在 provider result 返回后、Worker receipt 提交前注入故障。
2. 重开 DomainStore、交付 SQLite 和全新工具 runtime；reconcile 返回相同 versionId/digest，历史仍只有一个版本。
3. 模型继续请求只收到增量 function_call_output；输出引用的 bytes/hash/length 实际匹配，artifactRef 为 null。
4. 用户把 D1 改为 `User reviewed`；过期版本修改失败；第二轮真实 Worker 的 patch 更新 A2 和 B2 数字格式，保留 D1，产生不同真实 sourceRunId 的新版本。

保留文件：

- [Worker 汇集结果](evidence/worker-assembled.xlsx)：8093 bytes，SHA-256 `e898c41b06696211bc61d0124f842939472c406e3e42502e5796dc9559fb82d0`。
- [Worker 定向修改结果](evidence/worker-revised.xlsx)：8219 bytes，SHA-256 `144a5d39ec219d3aa000b21f5ce79dda18e7781801905c2a12667107a80978eb`。
- [版本与预期](evidence/worker-files.json)、[独立 ZIP/XML 核对](evidence/worker-independent-check.json)。

最终文件由 ExcelJS 4.4.0 与 xlsx-calc 0.9.2 接入后的真实 Worker 测试重新生成；全量 Worker 回归也在替换成熟库后再次通过（448 通过、46 跳过、0 失败）。独立核对使用 Python 标准库 ZipFile/ElementTree，未调用 SpreadsheetEngine：ZIP CRC、实际 SHA-256、B10 公式及缓存 217、C10 缓存 434、D1:E1 合并、列宽 22、行高 28 均通过；修改后 D1/A2 值和 B2 `0.0` 格式也通过。此脚本仅用于测试产物核对，不引入产品运行时。

重产出文件可在运行该测试时设置 `CREWON_F01_WORKER_EVIDENCE_DIR` 为证据目录；普通测试不写仓库证据文件。

## 未宣称的覆盖

脚本模型不是供应商真实模型。未在本子任务运行 GUI、Excel/LibreOffice 打开、F05 浏览器下载或生产远程存储。这组七条记录是 Worker 恢复专用 fixture，不冒充协调方订单规则验收数据；显式 rules/schema 已接通，订单清洗和来源追踪的独立验收由 F01 总体验收报告记录。
