# 原项目管理器的受保护 metadata 修改

原 `CreativeProjectApplicationService` 和 `SqliteCreativeProjectStore` 已在显式隔离模式接通改名、归档和恢复。复用原 Domain 变更配方、revision CAS、SQL 更新器、原事务和 receipt，不另建管理器或队列。生产配置仍未启用。

Host 只能从当前真实 UI 调用签发不可复制的 metadata mutation 来源。它固定原动作、请求、账号四字段及 profile/plugin/publisher，并保留原宿主和 UI 生命周期。原 Application 验证命令与实际调用一致，读准备阶段借用同一 Store 的限定视图，原 write 策略在最后异步 Host 检查之后复核；该来源本身不能替代独立项目策略。

内部 receipt key 从稳定插件范围、原动作、项目和外部 key 派生，原 requestDigest 不改。Store 独立核对实际 scope、pin、安装/包快照和该范围 key。回放在原事务读取，检查实际 owner、固定项目和保存 principal；COMMIT 使用同一个 owner 条件进行 CAS，末端再检查 owner 与调用活跃状态。其他插件和 legacy 项目不能被接管。schema 不完整、旧版本、改内容重用 key、安装撤权或身份不符均拒绝。写入失败回滚 metadata 与 receipt。

专项回归覆盖改名、归档、恢复、旧 revision、幂等回放与冲突、跨插件拒绝、命名 receipt 写入故障回滚以及准备后撤销 write 策略。真实 SQLite 与原 Application/PluginUI/安装 Store 参与；UI 发现及策略仍为命名内存 fixture，不能当作真实 Web/Native 发行证据。

普通读取来源不能升级为写入。后续已接通原 SQLite 的 brief 与概念素材/版本写入，见[内容与素材](./plugin-project-owned-content-mutations.md)；其他产物服务仍未接通。Foundation、PostgreSQL、Run/Tool、工作空间与中央会话接线及 Web→桌面完整验收仍未完成。业务插件继续保持卸载。
