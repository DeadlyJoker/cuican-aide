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

## 接下来必须完成的链路

1. 用原 Provider 目录更新主页选择器，成功发现时移除已下线模型，避免旧缓存或默认值重新注入；刷新失败与真实空目录分别表达。
2. 给原项目、资产、参考图阶段和执行计划传递模型选择，绑定同一目录发布的确切不可变插件模型版本。不能悄悄忽略选择、改成任意默认，或只在低层 HTTP 改模型名字而绕过原安装与 Run 资格。
3. 保持同一原请求的模型、来源、幂等身份和未知回执恢复不变；升级不能重跑旧任务或把旧模型执行当成新选择的成功。
4. 在正式桌面核验目录刷新、选择 sol/terra/luna、实际请求模型、流式回复及冷恢复，再继续 v6 读取和结构化 Agent 写入。原页面样式与基础交互保持，主仓未提交的模型设置改进和团队功能不被覆盖。

本记录只证明断点和部分源码修复，完整模型链路、正式桌面更新及 ReelBench 目标仍未完成。
