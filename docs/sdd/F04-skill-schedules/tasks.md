# F04 任务追踪

- [x] S0 独立 worktree 建分支、快进共享基线，读取规范与源码。
- [x] S1 提交 spec/design/tasks，明确 C04 v0/v1 兼容，报告协调任务。
- [x] S1 合入 F03 C02 核心与 F01 C03 权威依赖；更新动态日期、旧客户端、readiness、C05 映射设计。
- [x] S2 R01 固定 v0 JSON/摘要/HTTP/instruction/receipt 兼容行为与 SQLite 恢复。
- [x] S2 R02–R04 显式版本定义、保存与执行准入、目标scope、有界参数和错误恢复。
- [x] S2 R02/R07 三种动态日期规则，冻结具体 invocation，跨时区/DST/跨年验证。
- [x] S2 R01/R05 HTTP/BFF能力头、旧客户端过滤后稳定分页、无额外read授权、幂等。
- [x] S2 R04/R06–R07 每日程当前准入状态，取消、未知ack、重启同Run验证。
- [x] S2 R08 现有日程表单、固定版本/参数/目标、typed日期规则；组件/快照/窄屏检查。
- [x] S2 R06/R09 真正Worker接收v1流式请求（假模型端口），队列篡改参数在模型前拒绝。
- [x] S2 C05 提供真实 Run origin→已冻结具体 C02 invocation 的验证读端口，不授予权限。
- [x] S2 复用与自研边界评审；Node Intl、现有scheduler/receipt/UI/C02/C03，无 F04 新框架。
- [x] S2 必要窄/广检查与独立review，实际通过、基线失败、PG跳过分别记录。
- [x] S3 合入 F03 已提交真实宿主，保存/触发/Run lookup/重启/禁用/取消垂直验证。
- [x] S3 复现并修复准入后禁用的 SQLite 保存/Run 提交竞态；复用完整权威行解码与原子检查，保持 receipt/v0 兼容。
- [x] S3 合入 F03 公共 Skill UI 入口接线并验证（11 UI 文件/110 项，lint/build；真实宿主+日程+v0 共21项）。
- [x] S3 最终 feature 提交与交付报告；完整 E05 明确未验收，交协调任务联合验证。

协调任务继续的联合验收：F03/F05 真正浏览器、模型、交付与独立重复授权，执行中撤权/GUI恢复证据。F04 独立交付不把 fixture、前后准入检查或 SQLite 恢复当作上述联合验收。
