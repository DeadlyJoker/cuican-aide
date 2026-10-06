# 短剧插件的确认媒体执行协议

2026-10-06。Short21.0.0 已实现同包 T10/D18 的实际媒体工具，并通过独立安装包与原 Run/IO 双库集成。项目结果候选回写、Main、完整 Agent/手动流程和正式桌面媒体验收继续实施，完整目标保持 ACTIVE。

## 同包能力与两个入口

遵守[八阶段执行契约](./short-drama-stage-execution-contract.md)和[双入口编排](./short-drama-orchestration-spec.md)。各阶段产出由 Agent 创作、确定性检查与对应工作流配合，媒体只是其中一部分。工作流都放进 `crewon.short-drama`，后续分镜、视频、声音及合成逐项接入同一项目与计划。

本项承接[原 Tool IO](./project-media-execution-io-protocol.md)，增加实际插件工具：

| 工具            | 模型参数 | 实际行为                                                                |
| --------------- | -------- | ----------------------------------------------------------------------- |
| `media_submit`  | 空对象   | 从真实宿主读取当前 Run 已确认输入；首次领取并提交，已有记录只观察原请求 |
| `media_observe` | 空对象   | 只读原操作；尚无占用时返回未知，不检查素材或发起生成                    |

手动入口和原 Agent 对话最终调用同一个确认输入、候选意图与原 TaskCore/Run。本项没有新增页面按钮，原概念图、文字、资产和会话绑定继续使用原行为。媒体 scope 下拒绝项目编辑、资产编辑、上下文和原自由生图工具；不能通过旧工具绕过确认媒体输入。

## 可独立开发的 Node 协议

新增公开 `@crewon/contracts/project-media-execution` 入口与可逐字复制的协议源，插件自带同一文件，构建固定其摘要。冻结 `@crewon/plugin-sdk` 源码、dist及tar不变；使用已有可选 Node host service hook，声明 `crewon.project-media-execution@1`。

此 v1 在首个实际媒体包中包含两种明确方法；此前宿主私有接线没有交付声明此服务的完整插件包：

- `readInput({command})`：返回 `new` 或 `existing`。new包含原确认引用、工作流摘要、确认提示词和已经核验的逐角色目标图片路径；existing只包含原引用、工作流及原operation。
- `readOperation({command})`：返回 existing或null。只核原接受历史、原占用和观察许可；null不触发准备、源读取、上传或POST。

command在可复制协议中是不透明值。实际owner要求原 Worker dispatch/checked alias证明、真实活动invocation、匹配的包/Run和逐次用途授权。命令副本、setup调用、实例方法替换及伪造DTO不能读取输入或取得派发资格。已有操作观察不因当前源图锁定或改变而重做素材，但仍核历史身份、实际安装与观察许可。

服务只注入已准入的 `media.generate`；普通旧任务没有此服务。服务缺失时新工具拒绝执行，原工具继续可用。相同包/Run内同时使用实际native operation、候选占用和原受控网络owner，不能另起后端执行系统。

## 执行与恢复

T10固定角色参考及输出节点129；D18固定场景、角色一、角色二顺序和输出节点17；原概念图继续读29。完整渲染只改宿主确认的提示词、图像槽、输出前缀和原operation相关ID，宿主在领取及实际POST前比较全图并核原字节/授权。

首次reserve返回created才可发送，dispatchRef只能消耗一次。实际收到的prompt_id沿原CAS保存，即使响应到达时当前调用已取消或权限已撤回，也只保存已收到的原证据。响应丢失保留原operation和unknownOutcome；温恢复要求reconcile，冷恢复及不同Tool键均观察原记录，不产生第二次POST。取消不调用供应商全局interrupt，不准备素材，不把可能已经受理的发送当作未发生。

已成功或失败的原操作直接读持久证据，不再次HTTP。非终态按工作流自己的固定输出节点读取history/queue；其他输出节点不能替代结果。完整图片引用保存在原operation，最多16图并保留原16KiB记录限制；超限拒绝保存，不能静默丢弃原证据。Agent摘要最多四图，按UTF-8保持原9999字节字符串及16KiB外层输出限制，并提供实际imageCount/hasMoreImages。摘要裁剪不改原结果位置或持久证据。

submitted仅表示供应商受理，succeeded表示对应输出引用已经得到；本项没有读取、冻结并发布这些新结果的图片字节，也没有写项目采用指针。不能把供应商成功当作项目阶段完成。

## 兼容审查

旧已交付包及原SDK保持冻结，新版本单独交付。业务清单添加两个具名工具和可选媒体选择器字段，没有扩展旧公开HTTP或原SDK IO。原Node `image.generate` / `project.execute` 动作仍只接受确切 `{prompt}`；额外媒体字段、空对象和混合参数在调用task服务前拒绝。真正六字段媒体选择器只经原宿主专用TaskCore资格检查，业务清单的schema不是授权。

原清单字符串上限9999、受控JSON上限、配置字段和原积分准入保持。第一次私有构建的16384清单字符串上限被真实注册器拒绝，已恢复原上限；未改宿主schema解析器或测试保护。积分继续后置，使用原显式不扣积分模式。

UI/CSS源码没有改动。新ui.mjs与20.0.2仅有三条冻结SDK依赖路径注释不同，全部执行代码及样式逐字保持。原账户、设置、左右侧栏和工作空间/会话代码没有改动，用户实际App没有更新。

## 验证边界与下一项

私有独立目录使用冻结SDK tar及 `pnpm --ignore-workspace` 离线安装、编译和构建，未运行SDK build/prepack。311项独立包检查全部通过，含原UI和旧任务回归。实际文件安装、注册真实21.0.0清单/摘要、Node setup/工厂/borrow、TaskCore/Run准入、真实队列lease/start、项目采用来源、PNG/加密归档、native SQLite/PostgreSQL operation/占用和原IO owner都参与新集成。

新增16项双库检查覆盖两图实际handler、固定输出节点、原操作冷恢复、无占用只读、模型参数和旧工具越界拒绝、响应丢失的温/冷恢复、晚到受理保存、取消，以及有界模型摘要保留完整原证据。相关总回归以 `output/extensions/checks/short21-media-handler-20261006/verification.json` 为准；子集与总数不重复累加。

PDP/部署审查、DNS/供应商响应和私有Tool回执签发为具名夹具。原队列lease与媒体Run真实，但回执签发不是完整RuntimeWorker循环或真实模型。没有新增远端供应商请求，也没有把这组检查扩大为Main、产品页面、项目结果采用或正式桌面验收。首轮schema错误、初始独立目录误拾取workspace以及自有只读安装目录清理错误均保留证据；自有数据库和安装夹具正常关闭后按身份清理。

冻结新包：`output/extensions/installable-plugins/short-drama-media-handler-20261006/short-drama/21.0.0`，packageDigest为 `sha256:03a5c7dfe97c21513d72fe8788fe24e61c7cfa409cd265f9b53627525b329216`。安装目录是独立可验证交付物，并非用户profile的激活选择。

下一项读取并核验真实供应商结果字节，写入带来源的项目候选，再接Main、Agent与手动共用入口及完整Worker循环。随后结构化分镜与有界跨阶段计划，逐项接视频、声音和合成。
