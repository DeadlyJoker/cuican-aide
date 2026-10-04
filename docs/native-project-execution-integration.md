# Native 项目生成、查询与恢复装配

状态：ACTIVE。本文记录增量接线，不表示完整短剧在线流程、真实收费或打包 App 已交付。原首页、用户栏、设置、侧栏和公共样式保持。

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

## 验证范围与后续

统一证据为 `output/extensions/checks/native-project-execution-proof-20261004.json`。实际测试、文件摘要、首次失败及修复后结果以该证据及其日志为准；组间重叠，不累加。

本阶段验证严格契约、实际私有文件签发与加载、Native 实际装配、原 Main 和 Source Supervisor 兼容。测试中的身份、PDP、peer readiness、执行目标和历史数据是明确具名夹具，不能扩大为真实用户收费、供应商或模型执行验收。

下一步必须真实轮换 Source Supervisor 的 session/bootstrap epoch 后，生成和查询仍用原 key/input/旧 CAS 返回原回执。当前普通任务的历史 epoch 恢复已经实现；项目生成的 wrapper 回执及查询的 source/execution 双 pin 仍需分别处理，不能固定 epoch 或放宽完整 pin、价格、项目 reference 和当前 PDP 来通过验收。

完整目标还要求 Native Worker 实际执行、可用 ComfyUI 的同次完整 App 保存→生成→显式查询→图片选用→重启恢复、真实个人钱包/价格/结算、编译后的 Electron 完整链路及 E5 第二个真实企业 API。原用户配置、安装选择、生产映射、SDK 和已发行插件包没有在本阶段更新。
