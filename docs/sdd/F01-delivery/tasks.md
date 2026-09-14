# F01 任务与追踪

- [x] T01 基线、源码调查、spec/design/tasks（R01–R08），S1 提交与协调报告。
- [x] T02 Domain C03 严格解析及行为测试（R07）；F03/F04 已接受。
- [x] T03 ExcelJS/csv-parse/xlsx-calc 引擎、模板语义保持、公式校验、真实文件夹具（R01–R03、R08）；删除自写高层 parser/writer/calculator。
- [x] T04 Store/Application 身份隔离、不可变版本、幂等/CAS、持久恢复（R05–R08）。
- [x] T05 Control/session/真实下载、Worker 工具/恢复及 F05 下载导入 callback（R01、R04、R07）。
- [x] T06 生产任务面板上传、预览、修改、下载、刷新/冲突与组件快照（R01、R04–R06）。
- [x] T07 相关检查、真实 XLSX 独立核对、GUI 和持久恢复（R01–R08）；既有包边界失败与 UI soak 超时如实记录。
- [x] T08 提交后端与 UI/SDD，提供协调方可集成 commit、成熟库复用边界和验收缺口。

以下是协调集成/环境验收项，不计为已完成的产品实测：

- [ ] E01 正常企业登录 App → 任务文件面板的整页 GUI。
- [ ] E02 真实供应商模型自主完成交付与续改。
- [ ] E03 Nginx/Docker 实际容器启动验证。
- [ ] E04 F03/F04 消费 C03 与 F05 浏览器下载在集成分支的端到端验证。
