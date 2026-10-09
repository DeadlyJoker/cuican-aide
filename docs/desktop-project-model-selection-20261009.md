# 2026-10-09 桌面模型目录与插件执行核验

用户要求沿用原版从 `https://api.aicuican.com/v1/models` 获取可用模型并同步聊天选择器的逻辑，不再使用已下线的 gpt-5.5。当前桌面 0.1.45 尚未完成这一修复；不能把界面选中值当成真实执行模型。

## 已核实的旧链路与断点

- 普通聊天的原模型链路在 `adc644d97` 已存在：Main 的 `providerModelCatalogForForm` 通过原凭据存储与受控探测器获取目录，`RuntimeSupervisor` 发布可执行模型版本，`controlAgentVersionForModel` 将主页模型选择绑定到确切不可变 AgentVersion。
- 本轮正式 App 中，原设置页「获取模型列表」确实能调用同一服务，显示 sol、terra、luna；同时旧默认 5.5 被探测输出和表单的保留逻辑加回。单凭下拉框不能证明它仍由 API 广告。
- 模型设置页获得成功但空的 Control Provider 配置后，覆盖了存在的 Native 凭据目录，误显示「未配置」。实际原凭据文件有 aicuican 绑定和密钥库凭据，无需重新索要密钥。
- `ControlThreadRuntime` 的项目分支提前调用 `ControlProjectConversationTurn.start`，没有传递 `settings.model`；`startStage` 当前公开请求也没有模型字段。原 Native 插件准备器只编译后台默认模型来源，因此选 5.6-sol 后实际仍执行固定的 5.5。

最后一项已有直接证据：真实 Run `plugin-N_q8Nx3-akpYdTImb1f2IUwApMkkRnp6bM2u0vRvgGE` 的 UI 选择为 5.6-sol，但存储的 AgentVersion 与 `model_call_observations` 均为 gpt-5.5。三个失败 Run 都未调用项目工具；不能归因于 5.6 服务故障。只读证据见 `output/extensions/checks/short45-desktop-proof.json`。

## 本轮源码修复

Provider 探测成功时只返回实际广告且适用于 Agent 的模型，不再把已移除的旧默认值描述为可用模型；失败时返回失败状态和空的发现结果。原运行时离线缓存与降级解析仍独立保留，不能把缓存当作新发现。

模型设置页仅在 Control 明确未配置且无管理来源时，显示原 Native 凭据目录；有实际 Control 来源或非未配置状态时，仍以 Control 状态为准。这使原绑定可被正常编辑和查询，不改变凭据、权限、地址或原设置布局。

相关 Provider 操作、界面面板与凭据解析 44 项检查通过；真实探测输出和运行目录解析 6 项检查通过。UI/Native 类型检查及 Worker 类型检查通过。这些源码尚未安装到正式 App。

## 无网站登录的真实 API Key 核验

2026-10-09 使用原设备安全存储中的同一 Key，只在 Electron Main 内解析，未输出密钥、Cookie 或登录令牌；没有修改业务 SQLite 或凭据文件。认证调用结果如下：

- `GET /v1/models`：HTTP 200，`success: true`；更新渠道后本次响应仍广告 `gpt-5.5`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`。不能把用户更新操作等同于已验证移除，也不能据此认定是缓存还是 Key 限制。
- `GET /api/models/?p=1&page_size=20`：HTTP 200，但业务 `success: false`，消息 `Unauthorized, invalid access token`。HTTP 成功不等于管理接口授权成功。这个接口不进入 CrewON 使用路径，不要求产品用户登录管理网站。
- `GET /api/pricing`：HTTP 200，`success: true`；启用目录已不包含 5.5，也包含多种当前 Key 的模型列表没有广告的模型。因此不能用全部定价模型扩张 Key 的可访问目录。

已将 aicuican 目录探测接入两个成功结果的交集；真实运行新源码返回 `status: ok`，仅 sol、terra、luna，无 5.5。请求复用 Key、同源 HTTPS、原 DNS/socket 固定、无重定向、大小限制、超时和密钥回显检查；元信息失败不能退回旧目录。其他 Provider 保持原 OpenAI 格式探测，不调用 aicuican。

表单成功刷新后只列本次发现的模型，不把不可用的原默认值重新加回下拉选项；原设置布局保留。Main 只在保存来源的完整 endpoint 相符时复用存储 Key，用户更改到其他 endpoint 时不会携带旧 Key。这一约束参考主仓已有的未提交改进，未覆盖其设置与团队工作。

只读真实证据：`output/extensions/checks/aicuican-key-model-probe.json`。新增目录/网络行为检查 25 项通过；设置和 Native 凭据路由 51 项检查通过。UI/Native 与 Worker 类型检查、架构边界检查通过。正式 App 仍为 0.1.45，本批源码尚未安装；原后台默认、缓存与插件逐轮模型选择还需接通。

## Native 多模型准备进展（源码，尚未安装）

已接入真正的 Native V2 自动准备器：同一已安装包为 Key 目录中的每个 Agent 模型编译独立不可变来源、部署及插件版本。目录顺序不改变身份，Key 不进入编译产物；模型之间沿用同一配置、工具和审批要求。成功发现不再把旧默认值加回 Native 的运行缓存；真实空目录、无效目录与离线未发现分别处理。普通 Worker 的旧默认模型发布和项目每轮请求传递仍待修复。

Main 用它自己捕获的目录核对每一个来源和执行版本，不接受子进程追加的任意模型；Main 与 Worker 的目录必须一致。每个插件仍只有一个准备状态，首个已发布目标必须等于该状态的默认目标。Native 私有 Control 文件新增 `crewon.desktop-native-plugin-control.v2`，允许同一确切包与配置的多个不同执行目标；重复目标、包或配置混用被拒绝。旧 V1 继续只允许每插件一个目标，远程准备协议与单模型校验不变。历史查询只核对原包来源，使用同一配置的首个准备目标；不因模型兄弟版本误报来源不明确。

兼容性边界：没有修改公开请求、业务数据表或已发行插件包；内部私有文件的 V2 由同一 Main 写入并由更新后的 Control 读取。单个发现目录最多 24 个 Agent 模型，总发布仍受原 32 项及 1 MiB 限制，超限失败，不截断成成功。无模型目录的旧启动输入保持原单模型编译结果。模型请求与幂等恢复尚未接入，不把这批源码作为完整桌面升级交付。

只读实际安装包验证已完成：从正式 SQLite 读取 `crewon.short-drama@45.0.0` 的选中包、配置 11 和选择 35，加载磁盘中实际安装字节，成功编译并加载 luna、sol、terra 三个版本，每个保留同一组 32 个工具。未读取 API Key、调用网络、导入 Node 执行入口、提交任务或写业务 Store。证据为 `output/extensions/checks/short45-installed-model-siblings.json`，这证明实际插件兼容编译与加载，不证明外部模型执行成功。

本批检查通过：Worker 模型身份与候选准备 33 项、最终目录与 Native 工作流加载 17 项、Main/缓存/原远程启动回归 63 项、私有 Control V1/V2 与原任务事务 16 项；身份排序补充 4 项通过。它们有重叠，不作为独立总数相加。Worker、Native Main、Control 类型检查、架构边界及 `pnpm format` 通过。日志为 `output/extensions/checks/native-model-siblings-*.log`。执行选择、流式回复、恢复与正式桌面更新继续按以下顺序完成。

## 接下来必须完成的链路

1. 用原 Provider 目录更新主页选择器，成功发现时移除已下线模型，避免旧缓存或默认值重新注入；刷新失败与真实空目录分别表达。
2. 给原项目、资产、参考图阶段和执行计划传递模型选择，绑定同一目录发布的确切不可变插件模型版本。不能悄悄忽略选择、改成任意默认，或只在低层 HTTP 改模型名字而绕过原安装与 Run 资格。
3. 保持同一原请求的模型、来源、幂等身份和未知回执恢复不变；升级不能重跑旧任务或把旧模型执行当成新选择的成功。
4. 在正式桌面核验目录刷新、选择 sol/terra/luna、实际请求模型、流式回复及冷恢复，再继续 v6 读取和结构化 Agent 写入。原页面样式与基础交互保持，主仓未提交的模型设置改进和团队功能不被覆盖。

本记录只证明断点和部分源码修复，完整模型链路、正式桌面更新及 ReelBench 目标仍未完成。
