# 短剧媒体 Worker 上下文与提交前检查

2026-10-06。状态：私有宿主上下文与字节检查组件；安装插件的工具服务、实际供应商提交及结果回写继续接线。基于[原Run事务关联](./project-media-generation-run-protocol.md)，不增加第二个Worker或Agent运行时，不发布新的SDK/HTTP服务。

## 两种用途

原 `InstalledPluginRunContext` 继续读取真实Run、绑定、task admission、原回执、资金准入、安装、配置和当前身份/权限。新增宿主专用admission投影只接受该实例实际发出的快照；复制一个相同DTO不取得资格。

`ProjectMediaRunContext` 仅匹配同包 `crewon.short-drama` 的 `media.generate` action。普通短剧任务和其他插件保留原路由，包括其他插件自己的同名action。构造绑定真实Run reader、双库ExtensionStore和原媒体准备服务的原型方法，实例覆盖或伪端口不能代替实际读取。

独立 `projectMediaRun:submit` 与 `projectMediaRun:observe` 核真实actor、原Run及确切输入/执行意图；每次操作同时重核原安装执行身份和媒体输入读取资格。停用阻止新提交，授权的原任务观察仍可沿历史恢复；撤销或身份/PDP失效拒绝相应用途。

## 确切历史

双库在同一连接、事务及项目锁内读取接受关联、原输入修订和各素材初始记录/verified事件，核物理索引、摘要、actor、准备请求、角色顺序和完整目标。既有输入/准备/关联schema及不可变保护保持，不新增迁移或持久字段，不重新核当前采用来源来改写历史。

宿主内部完整记录包含提示词和受控目标路径，不能注入模型上下文。对外的私有快照投影仅包含引用及工作流，WeakMap保存实际历史与原Run快照；复制快照或跨reader使用拒绝。没有从UI或模型接收URL、供应商路径或新的提示词。

## 首次提交与原请求观察

`prepareSubmit` 只供尚未发送的供应商操作使用：先重核用途及原身份，再由实际 `ProjectMediaMaterialPreparer.observeInput` 观察每个原目标副本，检查当前输入head、来源/安装、实际字节和已接受的全部准备事件。返回前再次核权限和原历史，只有全部一致才返回确认提示词、工作流摘要和原有序目标路径。期间撤权、修改head/来源或替换远端字节时拒绝输出。

`readObservation` 读取原工作流和输入引用供已有操作恢复，不读取源图、不上传、不观察当前参考字节，也不重新生成。用户改过项目后，旧任务仍属于其原输入。此方法尚未执行供应商结果查询，operation身份及一次性发送/未知恢复继续由原外部执行记录控制。

本组件的返回值是已检查的**渲染输入数据**，不是Tool执行或网络授权。下一项必须在原Tool owner的实际command、invocation、operation reservation及受控IO边界内接它：首次发送前检查，已dispatch/受理未知时只沿原操作恢复；不能因拿到DTO而发HTTP，也不能先创建新operation来规避旧未知状态。真实工作流适配器还须核模板摘要与已接受工作流摘要相同。

原Run唯一不等于供应商请求唯一。现有通用IO按Tool请求键派生operation，模型再次调用可产生不同键。媒体候选在接线时必须把原operation领取与候选占用放在同一原数据库事务，固定到已接受的executionId/Run；另一Tool调用只能恢复该原操作，不能领取第二个生成请求。观察结果未明时不释放这一占用；明确的新候选经过新的执行意图和Run准入。本组件尚未实现这个供应商请求占用。

## 验证与下一项

相关回归**239/239**通过、零失败/取消/跳过；新增27项上下文检查为其中子集，原Run媒体准入34项及原安装身份22项也包含在总数内。检查使用真实原TaskCore/Run、项目、SQLite/PostgreSQL、实际PNG、加密归档及准备journal。PDP、publisher/工作流部署清单、DNS和供应商返回为具名夹具；没有新的远端生成POST，也未更新用户App、冻结SDK或完整插件包。检查及正常退场证据见 `output/extensions/checks/project-media-worker-context-20261006/verification.json`。

覆盖确认提示词/路径、角色顺序、真实字节检查、源/head变化、独立用途、原安装停用、元数据撤权、检查后撤用途、owner/身份失效、冷读取、伪快照/依赖、getter及异步活动回调拒绝，并回归原任务、文字计划及安装身份。首轮夹具字段/类型错误保留，修正实际夹具引用，不放宽产品保护。

三份各自有界的原准备记录组合后超过64KiB时，按实际已验证的输入/link/初始记录/事件摘要逐项比较，不能把组合历史送进旧单条JSON限制。真实双库大记录与冷读取检查同时断言原通用64KiB保护仍拒绝整个组合；原配置16KiB限制也保持。较早的夹具超过配置限制被原解析器拒绝，随后将夹具调到实际合法范围；未扩大原协议限制。

一次全文件并行回归使旧PostgreSQL测试超过其10000ms限制；最终按文件并发4执行，原测试超时和内部并发断言不变。原失败、正常退场及最后成功日志均保留，五轮自有PostgreSQL正常停止并按目录身份清理，运行均已结束。Application/Store/Runtime-worker类型、架构边界、仓库与TS格式检查通过，旧SDK源/dist/tar、原完整插件包和App保持核验通过。

继续接安装插件Tool服务与包内T10/D18渲染/查询，沿原operation一次发送和未知恢复，再接项目结果候选回写、Main批准以及两个产品入口。其后推进[结构化分镜和有限跨阶段计划](./short-drama-orchestration-spec.md)。当前不是正式桌面或完整媒体流程的验收，完整目标保持ACTIVE。
