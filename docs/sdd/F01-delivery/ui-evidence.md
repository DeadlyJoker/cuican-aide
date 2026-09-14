# F01 UI 与客户端验收证据

2026-09-14。实现与证据位于当前独立 worktree，未向原始工作区写入或发布。遵循 `crewon-design-reference` 和 `crewon-command-design-regression`：读取桌面设计 HTML/CSS、交互脚本及现有 CommandWorkspace 样式，保留首页/Scene/执行目标结构。

## 实际接线

- `App` 将现有 `ControlApiClient.delivery` 提供给任务工作台；仅 `thread:` 来源显示「文件交付」页签。普通会话输出没有文件身份，不进入交付目录。
- `DeliveryControlClient` 复用已有 session、CSRF、Origin、凭据和幂等策略。新增响应有字节限额和运行时字段校验；目录绑定任务/空间，分页校验工作表与游标，下载逐字节限额并核对 SHA-256。历史数组使用显式 `responseShape: array`，其余旧接口继续要求对象。
- 完整 CSV/XLSX 字节上传；全部工作表可选。汇集要求明确来源、表头行、目标表/行及列映射，支持用户启用排除、必填字段、异常/来源表、分组汇总。
- 单元格编辑固定 versionId/digest，成功保存不可变新版本；冲突保留值/类型/显示格式，并在编辑处显示原因。只有显式载入最新版本才更新修改基线。
- 按任务/客户端重建请求作用域；旧请求中止，旧目录与预览不能切入另一任务。页签内切换保留当前编辑。

## 真实 GUI 与文件证据

验收页面：`http://127.0.0.1:4560/docs/sdd/F01-delivery/gui.html`。这是生产 `DeliveryPanel` + 真实 Control API / application / SQLite 的独立合成材料验收页，**不是模拟 API**。合成输入见 `fixtures/`，包含 7 条订单、2 份 CSV 与 4 工作表 XLSX 模板。

2026-09-14 12:06–12:10（Asia/Shanghai），成熟库版本 ExcelJS 4.4.0、csv-parse 7.0.2、xlsx-calc 0.9.2：

1. GUI 明确选择两份 CSV，匹配 5 列表头；启用 `status=canceled` 排除、amount 必填、异常与来源记录、channel/currency 分组求和。
2. 保存 `gui-exceljs-订单核对.xlsx`：读取 4+3 行，写入 3+2 行；排除 1 条取消订单，1 条缺金额进入异常。明细 6 行含表头；汇总为直营 CNY 180、直营 USD 10、渠道 CNY 150；模板公式 `C2*1` 显示 180；来源表 8 行含表头。
3. 首版 `a90d9ea2-92f8-41f5-bc91-7c7cb0c4f13d`；H1 人工备注生成 `e0558324-3aeb-4b9c-980a-ca49b8ad304d`；D2 保持数值 100、显示格式设 `0.0` 生成 `054391c9-863a-4dc2-ba1f-3f21d0945ffc`，H1 备注仍存在。
4. 从历史打开首版，对 D2 输入 101 保存被真实 409 拒绝，草稿 101 保留。显式载入最新版本后基线变为 `054391c9...`，草稿仍在；随后取消该验收草稿，未推进 head。
5. GUI 下载实际落盘。`evidence/gui-exceljs-v3.xlsx` 是下载文件原字节，8,770 字节，SHA-256 为 `ad5986d7d32d33605f65d1b221eb34a795bed308f0a76d6702ebc6e46e1e6f46`。独立 Python ZIP/XML 核对：D2 为 100；样式 164 定义 `0.0`；H1 为「ExcelJS GUI 人工备注保留」；合并 H1:I1 保留；汇总 D2 公式 `C2*1` 与结果 180 保留。见 `evidence/gui-exceljs-file-verification.json`。
6. 原本为空的隔离任务通过浏览器 filechooser 一次上传两份 CSV，再上传模板，真实目录显示 3 份原件/0 份交付；返回订单任务并刷新仍显示原 3 份输入和两项不同引擎验收交付，未串任务。

零值公式缓存修复后重新启动真实服务，保留原 SQLite 数据库；于 12:14:27 再次通过 GUI 生成 `gui-final-订单核对.xlsx`，版本 `370ed5d9-f211-4671-b436-87b981bed4b3`。下载原字节保存为 `evidence/gui-final.xlsx`，8,597 字节，SHA-256 为 `9ff1d523aa9b91cac75b192fe833c3d744cb1b19414bd0ff522937206bbdef4b`。独立 Python ZIP/XML 再次确认五条有效订单、三组金额、B002 异常、8 行来源、模板原始备注、合并 H1:I1 及公式 `C2*1` 的结果 180；见 `evidence/gui-final-file-verification.json`。这是最终代码的生成/下载证据；零值公式本身由 root 的 artifacts 引擎回归覆盖，此 GUI 样例结果为 180。

截图均通过 CUA 读取生产组件，非图像生成：

- `evidence/gui-exceljs-summary-wide.png`：1280×900，真实分组金额及公式。
- `evidence/gui-exceljs-conflict.png`：过期版本冲突与保留的编辑。
- `evidence/gui-exceljs-summary-narrow.png`：390×640；document scrollWidth 375≤390，预览宽 327，无页面横向溢出。
- `evidence/gui-exceljs-summary-low.png`：1280×480；表格高度限制为 216，纵向滚动可到下载/修改按钮。
- `evidence/gui-exceljs-upload.png`：真实多文件上传与全部模板工作表。
- `evidence/gui-final-summary.png`：最终修复后生成的新文件、版本身份、三组金额和模板公式。

旧引擎过渡证据 `gui-v3.xlsx` / `gui-file-verification.json` 单独保留，不能作为成熟库最终结果。文件原格式证明来自真实 XLSX，HTML 表格预览只显示单元格值。

## 自动检查

- control-client typecheck 通过；完整包测试 108/108，包括新上传完整字节/认证、拒绝错任务、响应/分页限额、摘要下载、历史数组兼容。
- DeliveryPanel 行为与快照 6/6：超过 16 KiB 的完整上传、全部工作表分页、真实请求形状、冲突保留并显式更新基线、旧任务请求中止、业务汇总规则表单。
- TaskWorkbenchPanel / TaskWorkbenchStyle / DeliveryPanel / CommandWorkspace 首轮定向 68/68。
- CommandWorkspace 全部相关文件 12/12，122/122 tests。
- 最终 UI lint 与 production build 通过，保留现有大 chunk 警告。日志为 `evidence/ui-final-lint.log` 与 `evidence/ui-final-build.log`。
- 最终全 UI 检查为 407 suites / 2635 tests 通过、`scripts/soak/trend.test.ts` 一例 7 日循环超过既有 5 秒超时。该 suite 随后独立复验 4/4 通过（3.77 秒）。未修改超时或弱化检查；日志为 `evidence/ui-final-tests.log` 与 `evidence/ui-soak-isolated.log`。因此全套原始命令仍记为失败，独立复验另记通过。

## 明确边界

- 正常 App 入口停在企业登录，无当前已登录验收账号；首页设计通过现有回归验证，**正常企业登录→任务页面的整页 GUI 仍待集成验收**。没有绕过生产认证。
- 独立 GUI 使用合成输入和真实后端，但没有真实模型接入；不得标成模型自主交付通过。Worker / SSE / 模型和持久服务重启证据由 F01 root 单独记录。
- 浏览器 download 事件监听超时，但文件确实落盘；以下载文件、字节数、SHA-256 及独立 XML 核对为结果。
