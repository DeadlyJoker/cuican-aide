# 插件积分的只读查询与设置页

本阶段将原独立积分账本接到 Control API、Web BFF、Control 客户端和原「工具与扩展」页面。读取不创建账户、迁移 schema、赠送积分、报价、扣费或退款，也不改变原模型积分。

## 账户归属与兼容

服务端从原 HTTP 会话取得 tenant、principal 和 space；浏览器不能传入这些身份字段。新增 `pluginCredit:read` 政策动作，资源包含当前 principal 和可选 poolId。读取前后均检查当前政策，授权撤销后不返回已读取的钱包数据。生产 `DynamicPolicyAuthorization` 在 PDP 前拒绝跨租户、空间或 principal 的请求。

生产组合配置新增可选 `pluginCreditAuthorization`。旧调用者的配置继续有效，但缺少此权威时新查询拒绝访问，不继承安装插件的权限。正式 Control Main 使用既有生产 PDP。Standalone 使用原固定本机会话和同主体授权，不创建平台用户映射。

**Native 的本机 Control 主体仍不等于登录的平台账号。** 原 preload 存在时设置页明确显示「本机插件积分」和「登录账号的个人积分尚未接通」；不依靠 URL 的外观参数判断账户身份。Web 页面使用原账号会话。真实桌面个人身份绑定、入账、价格和结算规则仍是完整交付的必要工作，本阶段没有完成它们。

## 读取协议

| 路径                                   | 查询                                                   | 返回                                             |
| -------------------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| `GET /api/v1/plugins/credits/accounts` | `afterPoolId` 可选；`limit` 默认 16                    | 本人的账户当前页、`nextPoolId`                   |
| `GET /api/v1/plugins/credits/entries`  | `poolId` 必填；`afterRevision` 默认 0；`limit` 默认 50 | 所选账户当前余额、历史流水当前页、`nextRevision` |

账户页上限 16，流水页上限 50，revision 上限 2147483647。Pool 保持原账本的 opaque ID 规则，允许中文和 `/`，作为编码后的查询参数使用。未知字段、重复查询字段、无效游标和超限查询拒绝。没有充值或其他写接口。

两类 DTO 使用 `crewon.plugin-credit-accounts.v1` 和 `crewon.plugin-credit-entries.v1`。所有积分保持精确十进制字符串；不会经过 JavaScript Number。账户含可用、预留、已消费、累计入账和修订。每条流水含修订、grant/reserve/settle/release 类型、积分和当时账户快照；没有账本未保存的时间字段。

响应不暴露 tenant、principal、grantId、reservationId、凭据或内部引用。成功 DTO 上限 64 KiB；BFF 失败回复继续使用原标准错误 envelope 的 128 KiB 上限。客户端保留原认证传输、手动重定向和取消信号，取消前不派发，晚到已取消的响应不被接受。共享有限响应 reader 在已声明超限时也取消 body。

原五张积分表全部缺失时返回 `state: unconfigured` 和空数据；只读路径不会调用 migrate。已经配置但尚无本人账户时返回 `ready` 的空账户页。已配置而所选账户不存在时返回 404，不伪造零余额。部分 schema、错误 marker、同名 view、损坏账户或流水会失败。

SQLite 使用同一只读事务快照；PostgreSQL 使用 REPEATABLE READ READ ONLY。账户和流水属于同一快照，流水不超过当前账户修订。分页多取一项判断 next，客户端只保留当前页。Pool 使用 UTF-8 字节顺序，PG 显式 `COLLATE "C"`；旧非 C 数据库仍可读取，不新增索引或迁移。原 tenant/principal 主键前缀限制账户范围，非 C pool 索引可能需要在本人范围内排序，不承诺所有旧数据库均能直接使用索引顺序。

## 原设置页

新卡片只插入原「工具与扩展」内容槽，复用原插件卡、Button 和 Select。用户栏、设置导航、CommandWorkspace、左右侧栏与全局 CSS 保持。其他设置类别不发起积分查询。

用户先选择服务端实际返回的积分账户，再读取余额与流水。历史余额明确属于当条流水的修订，当前余额单独展示。刷新、换账户、换客户端、真实账号会话事件和卸载都撤销请求并清空旧数据，旧请求晚返回不会恢复旧余额。未配置、空账户、拒绝、暂不可用和请求失败有不同状态；恢复会话由原 App 创建新 Control 客户端。

## 验证与剩余工作

测试包含真实 SQLite/PostgreSQL 账本、实际 HTTP 与认证客户端、实际 Web BFF、原设置路由和两语言快照。具名测试资金采用 grant 100、reserve 30、settle 18；这不是生产拨款。更大的 48 位积分用于检验精度。

本阶段的测试、浏览器截图与前后账本比较保存在 `output/extensions/checks/` 下的 `plugin-credit-*20261004*` 文件中。全量 UI 误跑后已停止，不能算通过；按文件重跑的实际结果单独记录。

真实生产个人身份、资金来源与收费规则、Native Krea2 公网生成/查询、同次完整 App 的在线业务闭环及第二个实际企业 API 插件仍须完成。插件积分可读不表示外部生成服务可用，也不表示完整插件目标已完成。
