# F01 验收证据

2026-09-14。独立分支 codex/f01-delivery；基线 79bf09d88。实现与可集成验证已完成，完整企业登录应用和真实外部模型验收仍待执行。所有材料均为合成订单/测试模板，没有把模型声明当作文件。

## 提交与集成

- 98cda5b10：S1 spec/design/tasks。
- 9afef710f：C03 DeliveryTargetRef / DeliveryResultRef 权威定义与严格解析器，已提供协调方、F03、F04。
- 3745d6a797a2eb9f560aefe4dd1f91797da1154a：成熟库引擎、加密 vault、Application/Control、Worker 工具与恢复、客户端、上传传输，以及真实文件证据。已提供协调方和 F05。
- 后续 UI/SDD 收口提交在当前分支；未推送、未合并回原工作区。

F05 使用 configureDeliveryDownloads 回调对接同一 application。首版本地 standalone 需配置既有 Artifact 数据库与加密 key；远程/Postgres 模式没有交付 store 适配器，不能宣称支持。

## 需求与实际结果

| 需求                   | 实际证据                                                                                                                    | 结论             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| R01 完整输入/全部表    | HTTP 原件下载逐字节相等；四工作表读取；多 CSV/XLSX 全量处理；真实 GUI 多文件上传                                            | 通过             |
| R02 模板保持/公式      | ExcelJS 写出，独立 xlsx 与 ZIP/XML 核对内容、公式/缓存、字体、填充、边框、对齐、精度、合并、尺寸、core 属性；零公式缓存回归 | 通过限定支持范围 |
| R03 全量规则/异常      | 7 条订单→5 有效、1 取消、1 缺金额异常；直营 CNY 180、直营 USD 10、渠道 CNY 150；7 条来源追踪                                | 通过             |
| R04 真实目录/预览/下载 | 生产 DeliveryPanel + 真实 Control/service/vault，GUI 新建/预览/实际落盘；下载 hash/length 独立核对                          | 通过合成材料入口 |
| R05 定向修改/CAS       | H1 人工备注后 D2 改 0.0，备注仍在；真实 409 草稿保留；显式载入最新；并发仅一个 CAS 成功                                     | 通过             |
| R06 持久恢复/重试      | SQLite 关闭重开/新 runtime；故障注入后同操作恢复同版本；历史不重复；GUI 服务进程重启后目录可打开                            | 通过             |
| R07 身份/旧兼容        | session/CSRF、跨 owner/thread、伪造 Run、C03 解析；旧 artifact 全部测试；模型 prose 不创建目录记录                          | 通过             |
| R08 预算/拒绝结构      | 10 MiB 原件、9 KiB 页、全量遍历；ExcelJS.load 前非法稀疏坐标/合并膨胀 spy；精确上传 transport                               | 通过             |

细节：[引擎](engine-evidence.md)、[Worker](worker-evidence.md)、[UI](ui-evidence.md)、[上传传输](upload-transport-evidence.md)、[复用与自研边界](design.md)、[公式选型与探针](reuse-probe-formula.md)。

## 实际文件

- [订单精度修改结果](fixtures/orders-precision.xlsx)：5 条有效订单、180/10/150 分组、人工备注、0.0 精度、模板公式和缓存；[独立检查与所有摘要](fixtures/engine-manifest.json)。
- [Worker 修改结果](evidence/worker-revised.xlsx)：真实 broker/SSE/SQLite 路径，217/434 公式、人工 D1 备注、第二轮 Run 定向修改；[独立检查](evidence/worker-independent-check.json)。
- [GUI 最终下载](evidence/gui-final.xlsx)：最终零缓存修复后的代码生成，8597 bytes，SHA-256 9ff1d523aa9b91cac75b192fe833c3d744cb1b19414bd0ff522937206bbdef4b；准确文件名和独立检查见 [UI 证据](ui-evidence.md)。
- GUI 成熟库备注/精度/409 证据另存 gui-exceljs-v3.xlsx 和截图；旧过渡 writer 的 gui-v3.xlsx / gui-file-verification.json 明确仅为历史记录，不用于证明成熟库验收。

## 自动检查与未通过项

Node 24.19.0、pnpm 10.33.0。以下是实际运行结果，没有以跳过或放宽断言获得通过：

| 命令/检查                                          | 结果                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| pnpm crewon:boundary:check                         | 通过                                                                                                    |
| pnpm --filter './packages/\*\*' -r typecheck       | 全部通过                                                                                                |
| pnpm --filter './packages/\*\*' --no-bail -r test  | 15 包通过、1 包失败；test-contracts 的 3 项边界检查为基线已有问题                                       |
| domain / application / artifacts / control-client  | 132 / 175 / 37 / 108 项通过                                                                             |
| store                                              | 457 通过、93 既有环境跳过、0 失败                                                                       |
| control-api typecheck / test                       | 通过；169 通过、5 跳过、0 失败                                                                          |
| runtime-worker typecheck / test                    | 通过；448 通过、46 跳过、0 失败                                                                         |
| web-bff typecheck / test                           | 通过；20 项通过                                                                                         |
| desktop 传输定向测试                               | 36 项通过                                                                                               |
| UI lint / build / 定向回归                         | 通过，细项见 UI 证据                                                                                    |
| UI 全量                                            | 407 suites / 2635 tests 通过；soak/trend 七日循环一次超过现有 5 秒限制。隔离该 suite 4/4 通过，未调超时 |
| pnpm format / 修改文件 Prettier / git diff --check | 通过                                                                                                    |

包边界问题已在当前工作区内复制基线 79bf09d88 的相关源码独立重跑，失败同样存在。F01 仅登记实际新增库、domain 客户端依赖和 vault 的 fs/path；没有删除边界断言。比较结果 [package-boundary-baseline.json](evidence/package-boundary-baseline.json) 中 newViolations 为空，残留为既有 agent-kernel/domain/contracts/Node imports 的准入列表漂移。汇总和可重跑命令见 [checks.json](evidence/checks.json)。

## 明确待验收

1. 正常 App 入口被企业登录挡住，没有已登录账号；独立 GUI 使用生产组件和真实后端，不能替代完整登录→任务页验收。
2. Worker 的模型响应是确定性脚本，通过真实 HTTP/SSE、broker 和 store；没有真实供应商模型或真实用户业务材料，不标成模型自主交付验收。
3. Nginx/Docker 配置有布局与传输行为测试，但本机无 nginx 可执行文件、Docker daemon 未运行，未完成容器启动验证。
4. F05 浏览器下载端到端由其接入同一 importer 后验收；F03/F04 仍需在协调集成分支消费 C03。此处证明授权导入器和文件通路，不替它们宣称完成。
5. 支持范围以引擎证据为准；任意 Excel 功能、生产远程存储不在首版已实现范围。

## 重现

安装依赖后先使用 Node 24 和 pnpm。核心行为可运行 packages/artifacts、store、domain、application 测试以及 Control/Worker 测试。文件夹具运行 node docs/sdd/F01-delivery/fixtures/generate-engine-evidence.mjs 重产。Worker 可设置 CREWON_F01_WORKER_EVIDENCE_DIR 保存结果。

本地 GUI 验收运行 node --experimental-strip-types docs/sdd/F01-delivery/gui-harness.ts，打开 http://127.0.0.1:4560/docs/sdd/F01-delivery/gui.html。它只监听 loopback，使用合成身份、临时随机 session 和专用测试数据库；固定测试加密 key 仅限该入口。使用同一 fixtures 时可重启保留目录；首次启动应使用空 .tmp-f01-gui。生产应用仍使用正常身份管道。
