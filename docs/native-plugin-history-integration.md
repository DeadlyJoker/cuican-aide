# Native 插件历史读取与选用接线

本阶段复用现有 `StandaloneIdentity`、安装审批、文件 profile ownership、SQLite 与原应用服务，补齐 Native 的历史结果读取和图片选用。原账户、设置页、侧栏和全局样式未修改。完整增量插件目标仍在进行中。

## 接入与权限

现有 `createStandaloneControlApiWithPlugins` 的可信宿主配置显式传入 `creativeProjects.generationReads` 后，Native 配置装配增加只读历史授权；`generationReadUi` 和 `selectionUi` 分别批准确切 source package/contribution。`resultSelections` 仍必须提供原图片结果的可信 verifier。元数据、历史读取、选用的 publication 独立核对，批准其中一项不隐含批准另外两项。未配置保持原行为。

这些配置目前由可信程序装配，不是 renderer 字段。Main 的 Native 启动和私有审批文件尚未承载这些项目配置。本阶段没有把 Production 配置文件传入 Standalone，也没有改变既有 Native bootstrap v1 的格式。

历史读取先复核真实 HTTP session、loopback、Origin、CSRF、当前 actor/profile 和文件所有权，再核对持久 Run、原 binding、原安装准入中的 principal/actor/profile、原 package digest/publisher/version。原 namespace 必须来自当前批准来源或同 profile 的安装历史。原应用服务继续核对项目权限、原提交回执、个人积分预留归属和 business activation；撤销后拒绝读取。禁用或卸载包的历史可以保留，不需重新执行旧包。

历史授权只允许读取原生成 Run。它不能提交新任务、执行供应商查询、授权配置写入、获取报价或产生新的个人积分预留。历史查询 Run 仍需其独立查询归属接线，不借本阶段的生成历史授权。

## 生命周期与兼容

Web 和 Native 共用历史 action owner，但保留各自真实身份入口。共享 owner 借用实际 `InstalledPluginRequestOwner`，关闭自身不关闭宿主的请求 owner；Native 总装配继续负责关闭它所持有的配置和安装 owner。

普通读取在返回前重新验证身份、profile、source lease 和当前权限；关闭期间的迟到 JSON 拒绝返回。真实选用 COMMIT 后仍通过原 Application 的 opaque committed outcome 返回已接受结果；关闭不能把已提交选用误报为失败。重放沿用原 key、完整输入和旧 CAS；冷重开返回原回执，当前选用单独读取。

没有新增公共 HTTP、事件、SDK 或持久记录格式。现有插件 HTTP 路由将真实请求作用域传给历史 owner。Standalone 在打开数据库前检查全部三类 source grant 的独立安装批准，生成与供应商查询执行配置仍拒绝。

## 验证范围

- 新 Native 用例 **17/17**（14 个主用例和 3 个归属子例）：真实源包字节、文件 SQLite、HTTP 路由、精确图片选用、原 key 重放、冷重开、实际安装端口的版本切换、鉴权拒绝、迟到读取、COMMIT 后关闭及借用请求 owner 的生命周期。真实历史 owner 可以满足对应 mandatory 声明；元数据批准和缺失的恢复 owner 均不能替代它。
- 既有 Native runtime **8/8**，配置/审批/安装/activation 边界 **39/39**。
- 生产历史读取、选用、HTTP dispatch 与恢复组合 **35/35**，读取/选用/上下文装配 **26/26**；包含实际隔离 PostgreSQL 和 SQLite，零失败、零跳过。
- Control API 类型检查、TypeScript 边界和格式检查通过。检查日志及保护文件摘要位于 `output/extensions/checks/native-project-history-*-20261004.*`。

新增用例的源 UI 包经过真实文件安装与摘要校验；原付费历史的 target 包身份、资金和供应商结果明确为具名夹具。上述证据不证明真实 Native 付费执行、在线 ComfyUI、模型、报价或结算。

## 下一步

继续接通 Native 的私有项目审批配置、Main 与实际恢复 journal。只有声明动作的真实业务 owner 和恢复端口均可用，才发布对应服务。此次实际源包验证了缺少 mandatory `crewon.plugin-ui-recovery@1` 时拒绝启用；短剧 8/9/10 不因历史服务接上而被伪装成可用。

真实个人钱包与定价、生成/查询 Worker、在线 S0、打包版完整流程及 E5 第二个真实企业 API，继续按[原实施方案](./incremental-extension-subsystem-plan.md)验收。
