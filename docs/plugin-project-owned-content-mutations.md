# 原项目管理器的内容与素材写入

显式隔离模式下，原 CreativeProject 的 appendBrief、createConcept 和 appendConceptRevision 已接通同一个 Application、Domain 配方及 SQLite Store。它们与改名/归档/恢复共享原事务、版本 CAS 和范围回执；没有第二套产物管理器、Run、队列或模型请求。生产配置尚未开启。

Host 从真实 UI 调用签发当前动作的来源，准备阶段只允许读取这个项目及指定 brief/asset 所需的原方法。项目、素材 ID 和 brief revision 均与实际请求绑定；写入前保留独立 write 策略、原宿主生命周期、实际安装、完整 sidecar 与事务末端检查。普通读取来源不能升级成写入，旧 Run/Tool 的 receipt 与资格不改写。

原请求的范围 receipt 在生成新素材 ID 之前查询。重试返回原版本，既不重新分配 ID，也不重写历史。原 brief 内容摘要、素材版本和 brief 引用关系保持：以旧 brief 创作的素材不会因项目后来新增 brief 而被改绑。项目 metadata、brief、素材、版本和 receipt 在原事务写入；任何末端故障全部回滚。

专项测试走真实 SQLite、原 Application、PluginUI 与安装 Store，包含完整内容/素材/版本创建及历史读取、零新 ID 的回放、三种写入的真实 receipt 触发器故障回滚和重试、跨插件与混用项目/素材拒绝、同 revision 并发只提交一次、准备后撤销独立 write 策略及实际安装许可。测试的包发现和 UI 策略仍为明确内存 fixture，不证明真实 ESM 安装、Native、Web 或正式桌面已接通。

本次完成的是原 CreativeProject 的 SQLite 内容与概念素材配方，并非所有产物服务。Foundation/source/proposal、公开 Text/Asset v1、生成 Run/Tool 与结果选择、PostgreSQL、工作空间/中央会话、真实安装和 Web→桌面验收仍需继续接线。业务插件继续保持卸载。
