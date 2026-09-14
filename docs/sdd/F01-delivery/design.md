# F01 设计与 C03 契约

2026-09-14。S1 契约已由协调方、F03、F04 接受；实现使用 Node.js 24 / pnpm 10，不增加运行时或构建系统。

## 复用与自研边界

| 能力                              | 采用方案                                             | 本项目保留的职责与理由                                                               |
| --------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| XLSX 读取、工作簿模型、样式、写出 | ExcelJS 4.4.0，MIT                                   | 显式业务映射、准入和输出复验。已删除自写 OOXML 单元格/样式 writer。                  |
| CSV 解析                          | csv-parse 7.0.2，MIT                                 | UTF-8、资源上限、保守数值转换；前导零标识保持文本。已删除自写 CSV 状态机。           |
| 公式计算与依赖执行                | xlsx-calc 0.9.2，MIT                                 | 支持语法、资源预算、错误及循环防护。没有自写通用公式执行器或依赖排序。               |
| ZIP/XML 准入                      | fflate 0.8.2、fast-xml-parser 5.3.6，MIT             | 加载前检查展开量、结构、关系、坐标和合并膨胀；核对序列化 cache，不承担高层表格读写。 |
| 用户、任务、Run 权限              | 现有 session/CSRF、thread/workspace 授权和 Run store | C03 使用时再次鉴权；模型或 HTTP 字段不提供来源身份。                                 |
| 工具执行与恢复                    | 现有 ToolRuntimePort、broker、SSE 与执行记录         | 注册有界工具，以同一幂等键恢复已提交文件。                                           |
| 用户文件保管                      | 新 DeliveryStorePort / SQLite adapter                | 旧 Artifact 只支持 text/plain toolOutput 且到期清理，不能存用户输入和文件版本。      |
| 订单规则                          | 显式业务规则模块                                     | 排除、必填、异常、来源记录、按渠道/币种汇总是需求语义，不由通用库决定。              |

一手资料：[ExcelJS 官方文档](https://github.com/exceljs/exceljs/blob/master/README.md)、[发布记录](https://github.com/exceljs/exceljs/releases)、[csv-parse 官方文档](https://github.com/adaltas/node-csv/tree/master/packages/csv-parse)、[xlsx-calc 官方仓库](https://github.com/fabiooshiro/xlsx-calc)。ExcelJS 不计算公式，因此组合独立计算库。选型探针见 [公式复用记录](reuse-probe-formula.md) 与 [引擎证据](engine-evidence.md)。验收核对实际内容、公式、字体、填充、边框、对齐、数字格式、合并、尺寸和已声明文档属性；不以 ZIP 字节或样式编号相等定义保真。

## C03 v1

权威定义和严格解析器在 packages/domain/src/delivery.ts。包根供服务端使用；浏览器使用明确导出的 delivery、delivery-requests、delivery-http-policy 子入口。

```ts
type DeliveryTargetRef = Readonly<{
  schemaVersion: "crewon.delivery-target.v1";
  tenantId: string;
  spaceId: string;
  threadId: string;
  targetId: "thread-deliveries";
}>;
type DeliveryResultRef = Readonly<{
  schemaVersion: "crewon.delivery-result.v1";
  target: DeliveryTargetRef;
  deliveryId: string;
  versionId: string;
  contentDigest: string; // sha256:<64 lowercase hex>
  mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  sourceRunId: string | null;
  availability: "ready";
}>;
```

引用没有路径，也不授予权限。F03/F04 保存固定 versionId/digest，使用时重新鉴权。人工操作 sourceRunId 为 null，Worker 从真实 Run 绑定来源；ready 只在字节、验证、幂等操作与 head 全部提交后返回。输入记录可选 sourceRunId 保持早期记录兼容。

F05 通过 RuntimeWorkerCompositionConfig.configureDeliveryDownloads 获取 DeliveryDownloadImporter，再传给现有浏览器 runtime。导入器接收执行标识、文件名、MIME 和真实 Uint8Array，由 StoreBackedDeliveryAccess 从 Run 推导 actor/thread，幂等键为 browser-download:executionId。复用同一 application，不新增第二套服务，不接收模型提供的本机路径。

## 分层与持久状态

- Domain：C03、目录、检查、分页、汇集/补丁 DTO；拒绝未知字段、重复映射、无效范围及伪造就绪结果。
- Application：读取前检查 tenant/space/owner/thread 和输入归属；处理完成后再次检查权限及 Run，再提交已验证 bytes。
- Store：独立 SQLite vault，路径为 Artifact 数据库路径加 .delivery.sqlite。WAL/FULL 和 BEGIN IMMEDIATE 事务保存不可变文件、元数据、幂等操作与 head。AES-256-GCM 加密 bytes，HMAC 认证 metadata，密钥从现有 Artifact key 按独立用途派生；数据库文件权限 0600。
- Control：独立路由接入既有身份/CSRF；目录、分页、历史、汇集、补丁和二进制下载都读取 service，不从模型回复推导文件。
- Worker：同一 service/store，工具每次输出至多 9 KiB；broker 恢复使用原操作身份，不重复覆盖 head。
- UI：App 提供既有 ControlApiClient.delivery；任务内页签读取真实目录。切任务中止旧请求，预览/下载绑定版本；普通回复不产生交付记录。

首版支持 SQLite standalone，只有 Artifact 存储和密钥正确配置时启用。远程/Postgres 没有隐式本地降级；未配置时明确不可用。保存的输入与版本不进入旧 toolOutput 到期清理。

## 全量处理、验证与保存

上传存原始字节，检查所有工作表。分页限制上下文，不限制处理范围。汇集明确选择 inputId/sheet/headerRow、目标表/起始行和映射，遍历全部所选行。规则显式指定排除值、必填列、异常/来源表和分组求和；缺金额进入异常而非补零，有币种字段时要求按币种分组。业务数据写入非空单元格时拒绝，避免覆盖人工内容。

公式首版支持同表 A1、十进制数、SUM、四则运算和括号，引用仅数字/空值。去掉旧缓存后由 xlsx-calc 计算，验证所有结果为有限数值且没有错误类型。ExcelJS 的零缓存 getter 行为有明确兼容：读取实际序列化 v 元素核对 0，之后才允许重算。未知函数、共享/数组公式、外链、宏、透视、图表图片、表对象、自定义文档属性等未验证结构明确拒绝。

输出 bytes 由 ExcelJS 重新读取，先核对实际值、公式、缓存，再计算验证。未触及单元格使用库原生模型保留；只有显式值/公式/数字格式被修改。初始模板、输入原字节永不改写。

补丁要求 deliveryId、expectedVersionId、expectedContentDigest；CAS 成功创建新 versionId/parentVersionId，保留历史。相同 key/参数重试返回原结果，参数漂移或过期 head 返回冲突。409 保留草稿，仅显式载入最新版本才更新编辑基线。补丁后的公式检查针对当前文件；来源计数/合计明确标注仍描述初次汇集。

## 资源与传输边界

每文件 10 MiB，每任务 20 输入/100 版本；vault 默认总量 512 MiB，满额拒绝且不自动删成果。ZIP 展开 64 MiB，最多 256 表、100000 行、256 列。加载 ExcelJS 前验证 sheetId、坐标、最多 1024 合并范围及 100000 个展开单元格。公式最多 128 个、引用预算 200 万，另限嵌套/token 数；模型页最多 100 行且完整 JSON 至多 9 KiB。

Web BFF / desktop bridge 只有精确 POST /api/v1/threads/:threadId/delivery/inputs 允许 13,985,110 bytes 的 base64 JSON。流式累加先检查长度，普通请求保持原预算。Nginx 精确路径匹配该限额，容器包含 domain 子入口所需依赖。见 [上传传输证据](upload-transport-evidence.md)。

## 兼容与验收边界

不改旧 Artifact schema、toolOutput read 或 retention。客户端旧接口仍要求对象响应，只有新历史接口显式使用数组。新 HTTP、持久字段、缓存与 CAS 有行为测试。

Worker 验收使用确定性脚本模型，但 broker/SSE/SQLite/reopen 为真实实现；GUI 使用生产组件及真实 Control 服务的合成材料入口。正常 App 企业登录、真实外部模型、部署容器运行分别保留待验收状态，见 [总证据](evidence.md)，不宣称生产环境已验收。
