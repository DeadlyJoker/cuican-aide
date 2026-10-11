# 原项目管理器的隔离读取

原 `CreativeProjectApplicationService`、账号策略、项目数据和 `SqliteCreativeProjectStore` 保持共用。显式受保护创建模式下，Host 的八个原读取动作使用原 Store 的只读绑定视图；没有第二套数据库、项目管理器、全局可变请求上下文或插件可填写的 owner。默认和生产配置仍未开启该模式。

Host 私有发行器先核对实际 UI invocation，再固定账号四字段、profile、plugin、publisher、原请求与动作。不可复制的引用只活在当前调用，复制 JSON、调用结束、宿主关闭和源调用撤权均拒绝。它不是独立项目授权：原 Application 的 read/list 策略在读取前后仍执行；未实现绑定入口的 Store 明确拒绝，不能退回 legacy 读取。

八个绑定方法只开放原动作所需的读取依赖。例如 getBrief 可以读原项目和指定 brief，但不能改成素材读取或另一项目、另一 revision。视图没有迁移、写入和回执入口。生成 Run、Tool 与 Foundation 不因此获得访问资格。

实际安装记录、完整 metadata owner schema、原数据查询与 sidecar 校验在同一个原 SQLite 快照完成。完整稳定归属的 SQL 条件在游标、排序和 LIMIT 之前应用，避免其他插件占用页数；返回记录再次核对真实 sidecar 与保存 principal。查询前后复核原调用、宿主模块和安装批准，原内容摘要与版本校验保持。缺失/部分 schema 拒绝，不自动迁移或接管 legacy 数据。

专项测试使用真实 SQLite、原 Application、PluginUI 与安装/项目 Store，覆盖受保护项目、brief、素材和版本读取，分页前过滤，跨插件、跨执行身份与跨 profile 拒绝，独立项目策略、实际安装撤权、宿主关闭、引用复制/过期/目标替换，以及部分 schema 拒绝。素材正例是明确的 Domain 生成后持久数据 fixture，原 SQL 约束保持，不能当作受保护素材写入的证明。包发现与 UI 策略仍为命名内存 fixture；没有证明 Native、真实 Web 或正式桌面已接通。

当前读路径的原列表 SQL 和 Application 分页校验拆到专用模块，legacy 和绑定视图复用同一配方。原 HTTP/SDK 请求、响应 JSON、数据库项目记录和旧 legacy 行为保持；两个既有 Control 测试为 SQLite/PostgreSQL 方法联合类型补显式参数类型，未改运行断言。

剩余：受保护修改/归档与产物写入、Foundation/PostgreSQL 对等接线、完整 Run/Tool 资格、工作空间与中央会话绑定，以及真实安装→Web 验收→桌面交付。业务插件仍保持卸载；这次读取接线不表示完整插件体系已完成。
