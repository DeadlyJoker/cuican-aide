# Native 本机插件执行

本机路径沿用原 Electron Main、Control、Worker 和 SQLite。Web 与桌面共享产品源码；桌面运行打包时的快照，需要重新打包才能取得新的运行代码。插件不改变原账号、设置、导航和样式。

## 安装与授权

在原「设置 → 工具与扩展」选择独立构建的插件目录。来源审批、安装、启用是三个独立步骤。安装默认停用；公开 UI、信任 Node 代码均不自行授予外部网络或业务执行权限。

可信 UI 明确声明必需的 `crewon.creative-projects` / `crewon.plugin-ui-recovery` v1 时，来源导入可增量添加本机项目元数据的发布配置。该路径只保存和读取元数据，不生成任务、报价或钱包。

执行需要宿主在实际 runtime dataDirectory 下配置私有 `plugin-native-policy.json`，权限为 0600。其格式为 `crewon.desktop-native-plugin-policy.v1`，包含：

- `packages`：完整 `pluginId`、`publisherId`、`version`、`packageDigest`，以及 `approvalRequirement`。
- `networkGrants`：同一完整包身份、精确 HTTPS `baseUrl`、配置参数名 `baseUrlParameter`、允许的 HTTP 方法与路径。

Krea2 当前只需 `POST /prompt`、`GET /history/` 操作路径前缀和 `GET /queue`。修改审批或策略前，应正常退出 App，让原子进程退场；新启动重新捕获文件和配置。策略不接受任意来源或模糊包身份。

Main 从原 bootstrap、真实安装记录和保存的参数准备插件专用 Agent 版本，核对实际 Worker peer 后交付 Control。原默认 Agent 保持原路径。候选准备仅允许真实停用选择的确切 revision；正式提交仍要求已启用。Main 撤回时先写固定 sibling `withdrawn.json`，Worker / Control 拒绝继续借用旧权威，子进程退场后才清理自有临时文件。

Native Settings 的选择动作通过 Main 调用原选择 API，再对已批准、已准备的 Node 包调用原业务激活 API。完整配置与执行目标、原 CAS、幂等键和 Worker 校验保留；纯 UI 和原远端模式沿用原选择行为。选择已保存但激活失败时，界面读取实际状态并保留同一请求供显式重试，不合成成功回执。冷启动只恢复已启用选择的缺失或已启用业务记录，不覆盖既有停用或撤权；匹配的激活记录不重复写入，也不增加选择 revision。

## 项目生成与积分后置

短剧模块到 Krea2 的生成、查询和选用映射需要明确的 v3 项目执行审批。`composeDesktopLocalComfyProjectExecutionApproval` 只从真实批准的 UI、真实准备 release 的完整身份、参数和执行目标计算配置；该 helper 本身不授予运行权限。

项目就绪、生成和查询分别核验来源 UI 包的 `read` 与目标 Node 包的 `submit` 权限。来源仍需完整安装身份、当前启用状态、发布映射和 UI 策略允许，不因只读用途绕过核验；目标始终要求真实执行授权。同一个包同时承担两种角色时也分别检查。普通 Node 任务仍只走 `submit`，纯短剧 UI 不需要额外 Node 执行授权。

用户要求积分后置。本机显式采用 unmetered 准入，与原计费准入互斥。准入证明和原任务在同一事务保存，后续读取、查询和选用继续核验原证明及完整来源。没有创建默认钱包、余额或零金额报价，不能据此宣称个人积分与结算已接通。未配置此本机权威的原计费路径仍严格要求有效报价。

Worker 读取原生成任务和项目回执确认均使用同一严格的准入证明校验：paid 与 unmetered 必须存在且只能存在一种；缺失、同时存在或原绑定不符都拒绝。查询继续绑定原供应商 operation，不新建这两类准入证明。原请求已提交但回复未确认时，恢复沿同一原键读取原 Run，不修改输入、配置或任务版本。

两个业务任务工厂的新 ID 以固定 alnum 前缀接完整 32 字节随机量，UI invocation 使用原协议。历史裸 base64url Run ID 可能以 `-` 或 `_` 开始，Worker 的 Run、来源 Run、保留结果 Run 字段和 ActionIntent.runId 仅增加原 43 字符格式兼容；不重写 ID 或扩大其他身份字段。供应商 operation 仍由原 Run 与完整绑定派生，改写旧 ID 会破坏同次操作身份。

真实桌面验收结果及保留范围见 [实施进度](./incremental-extension-progress.md)。进程测试的启用与停用不等于实际供应商生成。
