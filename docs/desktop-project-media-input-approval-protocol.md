# 桌面共享媒体输入的独立批准

2026-10-06。状态：原 Main 私有文件的独立声明和原 Native TaskCore 装配已实现。用户 App、插件页面服务与 Agent 媒体输入工具尚未启用这一入口。本项接续[共享确认输入的 Control 协议](./project-media-input-control-protocol.md)，按[八阶段双入口方案](./short-drama-orchestration-spec.md)推进。

Agent 对话和手动工作台随后通过同一个宿主 owner 保存、读取确认输入，沿同一项目和输入修订执行。批准文件不替用户决定提示词、采用参考或启动生成，也不把生图扩展为整个短剧流程。

## 独立声明

原 `crewon.desktop-plugin-approval.v3` / `crewon.desktop-plugin-bootstrap.v3` 中，`projects` 可选增加 `mediaInputs`。它使用独立 `crewon.desktop-project-media-inputs.v1` 数据形状，不改变旧历史、SDK 或媒体执行协议。

| 字段                  | 约束与作用                                                                 |
| --------------------- | -------------------------------------------------------------------------- |
| `version`             | 固定 `crewon.desktop-project-media-inputs.v1`                              |
| `purposes`            | 明确的 `read`，可另加 `write`；不接受执行、素材准备或网络目的              |
| `reviews`             | 审查后的确切目标包与工作流，1–16 项                                        |
| `referenceIdentities` | 允许解码原参考结果的确切插件版本、manifest 和 implementation 摘要，1–32 项 |

每份 review 包含目标 plugin/publisher/version/package/manifest/implementation 六项身份，以及确切 workflow ID/digest/output。目标只能是 `crewon.short-drama`，必须属于原批准的 publication。T10 `krea2-reference-four-view` 固定 image/129/workflow-native；D18 `flux2-three-reference-storyboard` 固定 image/17/workflow-native。相同目标/工作流重复声明、错节点、未知工作流和未知字段拒绝。

声明最多 24KiB，批准 publication 投影最多 16KiB。只捕获有界、可移植、自己的 JSON 数据，不执行访问器。旧 v1/v2 bootstrap、旧历史项目配置不接受新增字段；原 v3 execution 配置没有它时保持原行为。声明还要求原文字和资产数据协议存在，不能跳过共享项目来源。

保存命令先读取原回执，因此保存需要显式 `read` 和 `write` 两个目的；`write` 单独声明拒绝，不暗中补读取授权。只读批准能读取当前/历史输入，保存被拒绝。原文字、资产、UI、任务或生成批准都不自动授予这项能力。

## 原 Main 与 Native 装配

原 Main `prepareDesktopPluginBootstrap` 使用共同解析器生成并固定私有启动文件。这份 bootstrap 环境只增加原启动路径；会话熵不写入文件。批准文件的字节、目录/文件身份和撤销仍沿原 Main 协议检查，批准被等字节替换也失效。

原 Control 从已加载的文件声明装配，没有复制配置或经通用项目配置注入 owner。`composeDesktopProjectStartup` 只向通用项目服务传递原项目数据配置；`mediaInputs` 留在原文件批准中。存在媒体声明时必须使用原 NativeControl，不能退回旧 task/activation 装配。

原 Native authority 的私有请求和事务 hooks 提供这项 PDP。批准的目标包须与原 Native authority 一致；若已有准备条目，其六项业务身份必须完全一致。已批准但尚未准备/启用的包可保留声明，这不证明保存或执行可用。实际保存仍通过原安装选择、当前配置、已采用资产/参考及输入协议检查。

可选媒体 owner 由实际 TaskCore 构建，借用同一 SQLite parent 和原 issued request owner。Main 文件、原调用者、profile、请求信号和生命周期在 await 前后以及 SQL 提交前持续重核。只开放独立输入读取/保存、当前项目读取和限定安装读取；`qualifyInput` 不获准。原 Native policy、网络批准、报价、素材准备、Run、候选及采用不合并进本声明。

前一轮 Core 新增严格 publication 捕获后，三个真实调用方仍传入完整 UI publication，导致原装配失败。本次修正 Native、桌面付费和生产三处调用方：验证过的完整 UI 发布记录继续归原 UI authority，Core 仅接其需要的 `pluginId/packageDigest` 投影。没有放宽 Core 字段检查或丢掉原 UI 审查。

## 已验证范围

原 Main 文件生产者覆盖声明保存、只读目的、错误目的/隐藏网络字段和等字节批准替换。原 Native 集成使用实际 Main standalone 身份、原文件加载/撤销、冻结 Short21.0.1 的实际安装与业务注册、实际 SQLite/Core/issued request 及原认证 HTTP。新 Native fixture 只用原服务创建项目，不伪造已采用参考、供应商结果或媒体回执。

两套检查分别验证原 Main 文件生产者和 Native 消费装配，未进行正式 App 联合验收。Main 生产者使用离线身份数据；Native 的原项目初始授权、审查图摘要及未调用的 peer 是具名夹具，原批准文件校验、身份、Core 和 SQL 未替换。新增生产 TaskCore 检查用实际 PostgreSQL 和安装字节覆盖完整 UI publication 的兼容装配、原 Core 绑定、缺省媒体 owner 和退出后 parent 仍可读取。

Native 读取缺失输入返回 `state:null`；只读保存返回拒绝，明确读写仍因缺少真实安装选择/已采用来源而拒绝，不能凭声明直接保存。实际 parent/Core 退出并冷重开后，原项目数据保留，新的原请求 owner 能重新读取，旧 owner 不能复用。复制声明、等字节替换批准、原 Main 撤销和准备 manifest 不匹配均拒绝。全过程未调用 peer、上传、图片 API 或生成。

这组 Native 检查没有成功保存新的 T10/D18 输入或恢复其回执；这些业务行为已由前一轮 Control 的真实双库检查覆盖，但其授权与来源仍为具名夹具。正式 Main 与完整插件/Agent 的成功保存、素材准备、Run、候选与采用联合验收继续实施，不混算为已交付媒体工作流。

扩大回归曾发现历史 v0 测试夹具误从当前 Short21 清单带入媒体工具，超过旧 16 工具边界。本次仅让历史夹具排除 v1 资产/媒体工具；原产品协议上限和当前 v1 工具保持。初始夹具身份、publication 兼容、只写目的、类型形状及扩大回归失败日志全部保留，不计通过。

最终相关回归 **142/142** 通过，覆盖21份完整合同/Control文件；原 Main **97/97** 通过，覆盖8份完整文件，均零失败、取消或跳过。新增12项为上述检查中的子集，不另累加。原 SQLite/Pg 输入保存/回执及原 Standalone Main 的物理子进程重启也继续通过。Contracts/Control 类型、原 UI/桌面宿主 lint、架构边界、合同生成、仓库及改动代码格式检查通过。

证据：`output/extensions/checks/project-media-native-control-20261006/`。冻结 SDK、旧完整插件包、隔离正式 App 和用户 App 的原摘要核验通过；本项未构建或替换它们。六批最终自有 PostgreSQL 保持持久性设置开启，正常停止后按目录身份清理，失败批次记录保留。

检查期间磁盘耗尽及原容量保护拒绝新工作，未降低容量门槛或断言。核实无打开文件后，只移除已结束、自有历史 UI 生产者的 `node_modules` 缓存，143 项源码、dist、包与锁文件的原摘要保持；另核验当前 Vitest 的临时模块缓存实现、目录身份和本工作树来源，清理四个已结束测试的编译缓存。当前 Vite/用户进程及私有用户数据备份保留，清理清单与失败日志均保留。分批运行保持所有21份原检查，原启动子进程批次采用文件串行避免容量峰值。正式用户 UI 未改变，积分仍后置，完整目标 ACTIVE。

下一项向同一个 owner 接插件页面与 Agent 输入工具，再接原媒体准备/Run 与结果候选/采用。结构化分镜、视频、声音、成片及有界跨阶段计划继续沿各自 AI 与工作流契约落实。
