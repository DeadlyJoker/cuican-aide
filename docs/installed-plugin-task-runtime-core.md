# 安装插件任务的共享装配核心

`apps/control-api/src/installed-plugin-task-runtime-core.ts` 将原 Production 任务装配中的 Application、实际任务 owner 和存储适配器提取到共享模块，为后续 Native 接入提供基础。它支持原 `SqliteRunStore` 和 `PostgresDomainStore`，没有新增运行时、公共路由、SDK 或持久数据版本。当前 Native Main 仍只有已批准的历史读取、选用和选用恢复；这个模块尚未授予 Native 生成、供应商查询或付费执行权限。

## 装配边界

共享核心借入真实父 store 和实际签发的 `InstalledPluginRequestOwner`。复制实例或伪造 prototype 不构成请求权威，源 publication 的独立批准在取得 SQL adapter 前核验。宿主必须显式提供当前 profile、业务和 UI 授权、包授权、价格端口、clock、ID 和摘要端口；核心在第一次 migration await 前捕获这些方法。它不创建身份、钱包、资金、价格、HTTP authority 或 Worker peer。真实 metadata-only request owner 没有 peer 时仍无法准备执行。

核心按原顺序迁移实际使用的 installation、extension、installed admission 和 credit adapter；配置生成或查询时另迁移其原关联。项目读取的 readiness 是 extension adapter 的实例状态，不能迁移一个实例后另取新实例，或伪造 ready flag。它创建原 `ExtensionTaskApplicationService`、配置和读取服务、`PluginUiCommittedTaskAuthority` 及三类实际 owner，保留原 Application 实例和 HTTP 私有绑定。生成与查询使用各自 publication；查询沿原生成 Run/operation 归属，不产生新的生成报价或积分预留。

Production wrapper 继续要求真实 `PostgresDomainStore`、`ProductionControlApiIdentity`、原严格配置和相同 install root；仍创建原 HTTP/报价 authority 与已配对 peer。共享 SQLite 能力不使 Production 配置对 Standalone 可用，也不把 activation 批准提升成生成或查询权限。

## 关闭与回执

共享核心关闭时同步撤回本地能力，关闭自身三个实际 owner 并等待已开始的 Application 和 owner Promise。借入的 requests、父数据库和外部 authority 由宿主关闭。普通读取在返回前再次检查本地存活；关闭后的公开 Application 方法保留 rejected Promise 语义。mutation 保留原 Application 的 COMMIT 和 opaque 回执规则，真实已提交结果不增加会误拒成功的通用尾部检查。没有以取消等待替代物理操作结束。

Production 总关闭仍先撤回 requests，再等待核心、metadata、peer 和 HTTP authority 的实际清理。共享核心与 wrapper 保留原启动及清理 AggregateError 分类。

## 验证与限制

- 新共享核心 SQLite **10/10**：真实安装 Node/UI 字节、实际任务/生成/查询 Application 和 owner、原键重放无重复报价或资金预留、旧生成 A 与当前查询 B、Native session/Origin/CSRF/actor/profile、无资金拒绝、metadata-only、伪造 owner 零 adapter、迟到读取和报价的物理关闭、真实 COMMIT 后的 opaque 回执，以及借入资源仍存活。
- 原 request owner **9/9**；查询装配前置条件修正后 **5/5**，原 source 未批准和缺少执行配置的错误、零 PG 打开及零身份读取断言保持。首轮失败用 HEAD 原 wrapper 也可复现；只为旧测试补齐实际 metadata reader 前提，没有放宽产品 guard。
- 原双库执行/装配组合首轮 **138 项通过**、一项上述旧前置测试失败、八项因缺少 ESM 输入跳过。后续原实际短剧 5.0 ESM 和 metadata PostgreSQL 专项 **12/12**，补齐八项 ESM 和默认组合的两个 PG 跳过项；默认 Native/authority 组合的其余 **88 项通过**。分组有重叠，不相加，也不把首轮失败日志改写为全绿。
- 原 Production PostgreSQL **Main/Control/BFF/Worker 进程专项 1/1**：实际 CLI 发布、两版不可变 Report 包、原 HTTP 配置和 activation、两次任务提交、原键重放、两个个人积分预留、两个版本绑定的 supplier POST，以及插件 binding 为 null 的原默认 Run。三个子进程、schema 和 pools 物理关闭；旧历史 proof 原字节恢复，本次 proof 单独保存。

新检查使用真实安装文件、SQLite/PostgreSQL、实际请求入口和业务事务；身份、profile、权限、定价、资金与模型/供应商响应仍是明确具名的离线或本地夹具。它们不能证明真实人类钱包、结算、Native Main 付费执行、在线 ComfyUI 或打包 App 全链路。当前日志和统一证据位于 `output/extensions/checks/installed-task-core-*-20261004.*`；自有临时 PostgreSQL 在全部消费者结束后正常停止并清理。

原账户、设置、侧栏、共享 CSS、renderer 资产、SDK、生产项目映射和短剧 8/9/10 发行包保持原摘要。下一步在原私有审批/真实会话与已挑战 Worker peer 上增加独立 Native 执行 opt-in，再接三类 action 和原恢复 journal；真实资金与价格来源、供应商可用性、在线 S0、打包完整流程及 E5 继续按原目标验收。
