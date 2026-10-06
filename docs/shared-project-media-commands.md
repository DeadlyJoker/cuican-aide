# 共享媒体生成命令

2026-10-07。接续[原媒体 Run](./project-media-generation-run-protocol.md)和[Worker 执行](./project-media-worker-composition-protocol.md)。目标是让同一短剧插件的页面和 Agent 使用相同输入、执行意图和任务，而不是分别创建供应商请求。

## 模块边界决定

素材读取、冻结、准备、输入资格和结果候选原来位于 Runtime Worker 内。Control 的宿主命令也需要这些能力，不能通过生产依赖导入另一个 app。因此将这些实现提取到私有 TypeScript 包 `@crewon/media-runtime`；包依赖既有 Application、Store、Artifacts 和 Domain，使用现有 Node/pnpm 工具链，不增加执行器、数据库或构建体系。

原 Worker 文件保留明确的公共重导出，确保 `instanceof`、私有状态和既有调用者使用同一个类身份。网络地址审查、固定 DNS 地址的传输、PNG 校验和受控上传均复用原实现，不复制两份。原模型、Tool、Run 调度与恢复继续属于 Worker；共享包负责素材和原任务创建前的协调。宿主原界面、SDK 与已发布插件包不受此次提取影响。

## 创建与恢复

`ProjectMediaGenerationCommands.generate` 接收逻辑业务选择：项目、保存的输入版本、预期最新版本、执行意图、原会话及修订、幂等键。Actor、profile、安装包、执行批准和服务地址由可信宿主提供，不能由这些参数替代。宿主 admission resolver 必须在素材 I/O 前核验原会话/工作空间、项目和当前部署权限。

首先沿原 TaskCore 的同一幂等键算法查找受理记录。已有记录时恢复原媒体关联，核验所有业务选择与原命令摘要，再走原 TaskCore 回执；不重新准备素材、不重新读取供应商字节。输入后来追加版本不会改变原任务。参数、会话或原会话修订改变时拒绝复用回执。页面和 Agent 对同一步骤应传入同一个持久执行意图和原请求键；单纯分别产生随机键不能当作步骤去重。

新执行先检查独立 `projectMedia:generate` 权限，再通过原素材 journal 准备并核验实际参考，最后由原 TaskCore 事务受理 Run。素材未知或被拒绝时不创建 Run。明确生成另一个候选才使用新的执行意图；SQL 的原唯一占用仍禁止同一意图产生第二个任务。

关闭服务会停止新调用并撤销待处理调用，但等待实际 I/O 和任务创建退场。原事务已成功提交时保留已知成功结果。共享服务只借用父存储及准备器，不关闭其他 owner 的资源。

## 产品接入范围

该服务是宿主内部入口，尚不直接注册 HTTP 或页面动作，也不把原内部 Run/候选记录原样返回模型。下一步在原 Control/Main 装配当前 profile 和会话权限，提供有界生成、查询与候选投影，再连接短剧插件按钮和 Agent 工具。候选采用需独立校验预期版本，不能用供应商任务成功代替采用。

真实外部生图、正式桌面双入口接力以及后续结构化分镜、视频、声音和成片仍需分别验收；积分继续后置。

## 原 Control Core 的存储和生命周期

Control Core 新增可选内部配置 `projectMediaGenerationStorage: { version: "crewon.project-media-generation-storage.v1" }`，只准备该 Core 实际使用的媒体任务受理适配器。省略时保留原行为，即使同一父数据库已存在相关表，也不能把另一个适配器的准备状态当作本 Core 已启用。旧版本、额外字段和访问器在取得存储适配器前拒绝。素材输入权限、素材 I/O、生成授权和页面动作仍各自独立；该配置不授予这些能力，也没有自动写入 Native Main 设置。

共享命令现在保留真正 `ExtensionTaskApplicationService` 实例上由 Core 安装的不可改写方法包装。此前直接调用类原型，会绕过 Core 对进行中任务的跟踪，导致关闭操作可能在实际任务还未退出时返回。新入口沿原包装受理，关闭等待物理任务退场；可修改的方法替换或访问器不被接受。未被宿主包装的原 Application 实例仍使用原类方法。

实际 SQLite/PostgreSQL 集成覆盖同一 Core 的创建与回执恢复、默认未启用、无效会话和关闭等待。该测试只借用原父数据库、请求身份和任务服务，部署/PDP及网络仍为具名夹具。恢复旧原型调用可稳定复现提前关闭，回归日志保存在 `output/extensions/checks/media-control-lifetime-20261007/original-bypass-regression.log`。本轮相关检查43项全通过，Control/Worker/共享包类型检查及7个桌面运行时组件构建通过。

这一步证明共享命令能经过原 Core，尚未完成生产 admission resolver 对当前项目、会话、工作空间和安装权限的完整装配。正式 Native 执行声明、页面/Agent 入口和候选采用继续实施，不能将这里的 Core 测试当作新生成按钮已经开放。

## 验证说明

使用实际 SQLite/PostgreSQL、加密素材、原 TaskCore、完整已安装 Short21.0.1 和真实 Worker 验证 T10/D18；模型流、部署审查及供应商网络响应使用具名夹具。覆盖原键冷恢复、手动追加输入后恢复旧任务、两个入口并发、外来批准、字段注入、权限拒绝及关闭等待物理 I/O。新入口测试主动缩短每次唤醒的边界数量，确认原 Run 经过真实持久调度继续完成，而不是重建 Run。

并行执行时，初始验收将原调度器 `run_execution_yield` 误当失败。按原5秒预算及1毫秒重排继续同一个 Run，最多8次；其他错误和不同 Run 立即失败。没有修改生产调度预算或放宽最终完成、提交次数和候选来源断言。最初夹具变量重名及该调度假设的失败日志均保留。

12个提取模块与原实现逐字节一致，13个旧模块导出与共享模块的对象/类身份相同；生成资格器只增加显式新执行的准备入口。原宿主 UI、SDK、Short26及历史完整包、已验收与用户 App保持。证据位于 `output/extensions/checks/shared-media-commands-20261007/`；这里不把具名网络夹具当成真实生图或用户桌面已经更新。
