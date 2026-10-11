# 原 SQLite 项目的受保护创建

`PluginCreativeProjectActionOwner` 的显式 `creationOwnership: "plugin-project-v1"` 模式，在原已授权的 UI 创建调用中捕获真实来源。默认不启用，原 HTTP/SDK 请求和项目响应没有增加 owner 字段。生产 Control 配置尚未开启此模式。

原 `CreativeProjectApplicationService` 和同一 `SqliteCreativeProjectStore` 使用独立的可选创建能力入口，仍借用原连接、BEGIN IMMEDIATE、Domain 创建校验器、项目/brief/receipt 写入器和提交末端检查。它没有第二份项目数据库、Run 或队列。未实现该能力的 Store 在项目 ID 分配之前拒绝，不回退成 legacy 创建；普通 Store 方法也不能接收创建 scope 选项。

来源固定账号四字段、profile、plugin、publisher 和原创建动作，项目 ID 仍由原 Application 分配。请求外部 key 保留，Store 使用七字段归属及入口派生内部 receipt key。读取与创建都验证实际来源对象、原 pin、安装/选择快照以及活跃调用；SQL 同连接再次验证实际安装记录。独立 `creativeProject:create` 在原 Application 执行，并在受保护创建的最后异步 Host 检查之后复核。真正 COMMIT 前保留同步来源和原 authority 检查。

新项目、initial brief、八字段 metadata owner 和范围回执在原交易一并写入。身份已被 legacy 或其他 principal 占用时拒绝，不能按作者或名称接管。sidecar 必须已由 caller 显式完整迁移，缺失或部分 schema 不触发迁移、修补或 legacy 回退。

回放读取相同内部 key，保留原请求内容摘要的冲突检查，并核对实际 metadata、完整 sidecar 归属、原创建审计事实和原 brief。回执或可计算的 key 本身不授予访问。普通项目读取继续过滤受保护项目；本次没有开放其他 CRUD 或产物入口。

实际 SQLite 测试由原 Application、PluginUI、安装 Store 和项目 Store 完成创建及重放，覆盖两插件同外部 key、事务失败回滚、确认 COMMIT 后 Host 关闭仍交付原结果、legacy 身份占用、独立项目策略拒绝、最后 Host await 内撤权、真实安装撤权、schema 缺失/不完整和原 SQL 拒绝创建审计事实修改且回放保持原值。包发现与 UI 策略使用明确的内存 fixture，未证明 Native 发行、真实包 ESM、Web 或正式桌面已接通。创建回执插入故障只作用于测试数据库的命名触发器。

尚未完成：Foundation 的新创建交易、PostgreSQL 对等接线及锁等待测试、完整绑定管理视图、工作空间/中央 Agent 产品接线、Native 安装授权与 Web/桌面闭环。业务插件仍保持卸载；不能把这个可选 SQLite 创建能力称为完整插件体系交付。
