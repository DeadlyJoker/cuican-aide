# Native 项目生成、查询与恢复装配

状态：ACTIVE。实际 Native Source Supervisor 三次启动已验证生成、查询的原回执跨 epoch 重放和三类 journal 恢复；不表示完整短剧在线流程、真实收费或打包 App 已交付。原首页、用户栏、设置、侧栏和公共样式保持。

## 批准数据与执行权限

新增独立 `crewon.desktop-plugin-approval.v3` / `crewon.desktop-plugin-bootstrap.v3`。`projects.version` 为 `crewon.desktop-project-execution.v1`，继承原项目、历史读取和图片选用数据，增加：

- `pluginGenerations.publications`：明确的 UI source publication 与生成 target/action 映射。
- `pluginQueries.publications`：明确的 UI source publication 与查询 target/action 映射。
- `uiRecovery.publications[].actions`：分别批准生成、查询、选用的原请求恢复。

每个 source 精确包含 `pluginId`、`packageDigest`、`contributionId`；target 另外指定 `action`。每类映射最多 32 项，整个项目数据最多 64 KiB。查询必须显式配置原生成历史 reader；恢复的每个 action 必须有对应的同一 source 映射。元数据、历史、选用、生成和查询不互相授予权限。

项目批准数据不接受供应商 URL、身份、凭据、价格或钱包。实际任务还需要分别签发并实际加载的 `crewon.desktop-installed-plugin-tasks.v1` 与 activation 文件：UI source 必须在任务 publication 内，执行 target 必须在 activation 内。这些条件不创建资金，也不能替代原 HTTP policy、执行包审批、报价或 Worker 执行授权。

原 approval/bootstrap v1、v2 与普通 Standalone 装配保持严格。旧入口仍拒绝项目生成/查询映射；不能把 DTO、解析后的副本、浅克隆或布尔就绪端口当成 Native 执行批准。

## 启动和生命周期

Main 在创建 Artifact、数据库和 registry 之前加载实际私有 bootstrap，完成项目及任务纯预检。Native 专用 startup 将纯项目映射绑定实际 FileIssued bootstrap、task、activation 与当前 owner/scope；公共 Standalone Native 入口重新核验这份绑定。

实际 Native factory 精确比较批准文件与装配后的六类项目字段及恢复配置。新的付费生成加图片选用组合在项目准备阶段先建立实际 source schemas，再迁移选用表；不插入钱包、价格或资金。随后建立原共享 task core，再接历史 reader、选用 owner 和恢复 journal。历史 reader 在实际 core 迁移完成后获取原只读 adapter，公共 HTTP 装配也取得实际只读 adapter，不伪造 schema readiness。没有执行 opt-in 的旧历史入口保持原启动顺序。

恢复借用同一个实际 SQLite parent 与原 request owner。每个执行 lane 必须有当前 core 的私有品牌及对应真实生成/查询 owner；选用必须有原实际 selection owner。缺失、克隆、其它 parent/request 或已关闭 owner 在获取 journal adapter 前拒绝。必需 Host 服务按实际安装字节的声明与对应 owner 判断，通用 fallback 不授予执行能力。Native activation 的 UI-only 包兼容检查借用同一实际 Host 服务端口，缺少对应私有品牌时仍拒绝声明必需生成/查询服务的包。

原 FileIssued bootstrap 对象贯穿 Native authority、configuration/request owner 与 task authority。后续请求继续核对原文件：leaf 的 inode、权限、属主、链接数、时间、长度与原字节，以及祖先目录身份和权限。改写、替换或撤销权限拒绝新请求；无关 sibling 文件不撤销批准。持续校验接在原权限和请求检查处，不增加 COMMIT 后的独立失败检查。

生成由原 Application 创建 Turn/Run 并完成个人积分事务；查询创建独立 Turn/Run，复用原付费来源，不新增报价或积分预留。查询仍是显式操作；恢复日志不自动重新生成、不重新报价、不更换原 key/input/CAS。`createThread` 仍不属于三类恢复协议。

Native 调用将 recovery 请求范围放在外层，把实际执行、历史读取或选用请求范围放在内层。这样实际准备好的 execution 状态不会被 recovery 的 configuration metadata 状态遮蔽。内层接收外层实际 `currentSignal`，继续受到原 HTTP、request owner 和 recovery 生命周期取消约束；关闭仍等待物理调用及确认事务结束。这个顺序不放宽 request-owner guard，也不增加已验证 COMMIT 后的当前权限检查。

## 原回执跨 epoch 重放

生成沿原 task v1 摘要和项目 reference wrapper 计算最终回执。查历史前捕获 actor、完整 pin、command、项目 reference 与真实 digester receiver；通过原精确存量主键及完整作用域取得实际 admission，仅恢复其已保存 execution `authorityEpoch`，再核验完整 pin、原 command 和最终 wrapper 摘要。每个候选回执只包装一层，不能拿未包装的普通任务摘要替代项目回执。

查询使用独立可选的 `loadPluginQueryTaskAdmissionByReceipt`，不借用生成准入。实际 SQLite/PostgreSQL adapter 先按原 task receipt 主键读取并核验完整查询 Turn、query admission、binding、原付费来源 admission/Turn/积分准入/预留和原 operation 记录；只在精确 key 不存在时返回空，损坏或错域的历史证明不能伪装为空后新建任务。Application 再核验原 source、operation、完整执行 pin 和原查询 wrapper 摘要。

项目查询还必须读取实际不可变 query link。已验证历史 admission 的执行 pin、Run、Thread、binding、operation、原 key 和摘要均与该 link 相同后，才允许从它恢复 source 与 execution 两个已保存 epoch。两个 pin 的其余字段、publication、保存 reference、原输入和旧 Thread CAS 保持精确；只有当前 epoch 变化不能产生新业务身份。没有可选历史 reader 的旧 adapter 保留严格 epoch 匹配，不获得跨 epoch 恢复能力。

历史证明不授予当前权限。生成和查询仍核验当前 actor/profile、包/贡献/动作、selection revision、原安装/执行 owner 与项目、任务、Thread、Run PDP；新 epoch 下撤权仍拒绝原键重放。成功回放返回原 Turn/Run、报价、积分和链接，不重复报价、预留或改写历史 pin。

## 验证范围与后续

前一装配阶段的基线为 `ee2fc065e`，证据为 `output/extensions/checks/native-project-execution-proof-20261004.json`。本轮跨 epoch 证据归档路径为 `output/extensions/checks/native-project-epoch-proof-20261004.json`；实际测试、文件摘要、首次失败及修复后结果以对应证据及其日志为准，分组重叠、不累加。

实际 Source Supervisor 集成 **1/1、零跳过**通过。用原 release CLI、Worker/Main 子进程、实际 FileIssued 私有 v3 文件、HTTP/ControlClient 和同一文件 SQLite 启动并物理停止三次，真实轮换 session/CSRF、bootstrap/task epoch 和 activation digest；旧 token 与 mountRef 拒绝。第一轮保存项目和概念图，当前任务 PDP 拒绝时没有新 Run、积分副作用或报价；允许后原生成提交仅产生一次 30 积分报价和预留，钱包初始 100 积分是明确具名测试资金，Worker 实际执行授权仍被拒绝。

第一轮所有进程物理停止后，测试才通过原 Run reducer 将来源 Run 从 queued 推进为 running，并预留具名 operation 记录，作为查询历史夹具；它不是 Worker、模型或供应商完成证明。第二轮原生成 key/input/旧 CAS 返回原回执，原不可变业务记录、wallet 和报价次数保持；随后显式查询创建一个独立 Turn/Run，不增加生成 admission、报价、积分预留或流水。Worker 同样拒绝执行，查询 Run 通过原客户端显式取消。第三轮三类 journal 的原请求与回执完整恢复，原查询 key/input/旧 CAS 返回原回执，当前 PDP 拒绝仍有效；选用只保持 prepared、派发次数 0、回执为空，没有提交图片选用。

最终 Application 专项与原兼容组合 **117/117**、实际 SQLite 与自持 PostgreSQL 18 专项 **106/106**、Control runtime 与实际 Native Main 组合 **68/68**、原及新增 Source/activation/IO 组合 **32/32**均通过、零跳过；上述三 epoch 专项包含在 Source 组合内，各组重叠、不累加。Application、Store、Control、Host 类型及 boundary/license 检查通过。自持 PostgreSQL 的所有测试消费者结束后已停止并物理 join、清理。测试中的身份、PDP、peer readiness、执行目标、100/30 积分和 operation 是明确具名夹具；这些结果不是 renderer、真实用户收费、供应商或模型执行验收。

完整目标还要求 Native Worker 实际执行、可用 ComfyUI 的同次完整 App 保存→生成→显式查询→图片选用→重启恢复、真实个人钱包/价格/结算、编译后的 Electron 完整链路及 E5 第二个真实企业 API。原用户配置、安装选择、生产映射、SDK 和已发行插件包没有在本阶段更新。
