# 纯服务插件的 UI 目录过滤

2026-10-12。正式 Control 的插件目录原本先对每个启用包检查 UI 发布权限，再判断包是否有 UI。没有 UI publication 的纯 Node provider 因此使整个目录返回授权错误，影响同一 Profile 的工作台入口。

现在原目录的全范围授权与有界分页保持不变。Host 的可选 `isNodeOnly` 端口先核验真实安装目录、包摘要、文件字节、身份和来源批准，仅对没有 UI entrypoint、没有 module contribution 的真实 Node 包返回排除结果。排除前后仍核对原 scope、selection、package 和授权 epoch。来源撤回、字节变更、跨租户、异常输出与 policy 错误均拒绝，不被当成“没有 UI”吞掉。

该端口只能从目录删除纯服务项，不授予 UI mount、asset 或 action 权限。非纯服务包仍执行原逐包 UI 授权、发布名单、完整字节核验和最终授权检查。直接打开纯服务插件仍被原 UI 政策拒绝，没有给 provider 补 publication，也没有执行 Node 代码。原 Host reader 的 UI 模式校验与身份校验拆成两个内部函数；原 publication/read 路径仍执行两者。Control 的原 reader 装配和 Application 的原页校验各抽为小模块，不增加管理器或持久化状态。

兼容性：内部 package port 的方法和 reader 的 inventory policy 都是可选扩展，原未提供该端口的调用方保持旧目录行为。Reader 的显式检查方法单独命名，只有正式 Root 的 package port 主动接线；直接注入旧 Reader 不会隐式开启新检查。启用新检查却没有提供 inventory policy 的 reader 拒绝检查。HTTP、SDK、安装包、数据库与已保存 selection 形状不变。

最终回归共 265/265、零跳过，覆盖原 Application UI、Host UI reader/服务、十一组 Control 普通任务与组合生命周期。实际混合 Native Profile 的纯服务 provider 具有必需 tasks v2，工作台消费者具有 tasks v1；即使真实消费者 setup 阻塞，目录仍只返回工作台，直接 mount provider 被拒绝，原任务等待恢复后重放同一回执且不新增 Run。新增 Application 测试检查 scope/epoch/selection 变化和异常返回；Host 测试使用真实安装文件验证源撤回、字节篡改、跨租户和禁止代码执行。

Application、Plugin Host、Control 类型与 TypeScript 边界检查通过。证据：[最终回归](../output/plugin-foundation/shared-task-binding-20261012/node-catalog-regression.log)、[Application 类型](../output/plugin-foundation/shared-task-binding-20261012/node-catalog-application-types.log)、[Control 类型](../output/plugin-foundation/shared-task-binding-20261012/node-catalog-control-types.log)。最初同时执行 SDK 重建与 Control 类型检查曾发生声明产物读取竞争；等待重建后单独检查通过。之后模块抽取暴露的类型错误也已修正并重新检查，没有弱化类型约束。

这是源码与真实本地文件型 SQLite 的行为证据，不是浏览器、正式账号页、外部模型、Worker 或桌面更新验收。本次没有运行 PostgreSQL，没有安装业务插件或部署产品。项目专用共享实例、Worker 必需服务与完整 Web 生命周期仍按基础建设清单继续。
