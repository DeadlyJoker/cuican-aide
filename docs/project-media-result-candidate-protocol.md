# 原媒体结果到项目候选（宿主内部 v1）

本协议接在 [Short21 媒体工具](./plugin-project-media-execution-protocol.md)之后。供应商成功回执中的文件位置还不是项目素材：宿主必须读取并核验原输出的 PNG 字节，冻结原来源，再写入同一项目的候选。候选保存不采用素材，不修改需求、剧本、角色参考或分镜指针。

这是内部执行组件。当前没有新增 HTTP、SDK、Main 服务、插件按钮或 Agent 工具；完整 Worker 循环、两个产品入口和采用操作随后接线。原前端、SDK、完整安装包和用户 App 保持。

## 输入与原来源

调用者只能提供原项目 `projectId`、原媒体 `runId` 和 `resultIndex`（0–15），以及宿主实际 Actor。不能提供 URL、文件名、供应商 operation、工作流、提示词或图片字节。

真实 SQLite/PostgreSQL ExtensionStore 的子存储沿原项目锁读取：

- 同归属的原项目及已接受媒体 generation link/input 历史；
- 原候选唯一占用的供应商 operation，必须 succeeded 且有原 provider operation；
- 原结果位置、T10 的输出节点129或D18的输出节点17，以及固定的原工作流摘要；
- 原安装版本、publisher、package/manifest/implementation 摘要和历史配置修订。

紧凑来源 `crewon.project-media-result-source.v1` 保存原执行引用、业务用途、输入/准备摘要、原目标身份、配置摘要/origin、操作摘要和原图片位置。配置凭据与完整提示词不进入来源。文件类型仅允许 `output`，路径不能越界；完整 `/view` URL 必须与原配置 origin 和原文件位置推导出的 URL 逐字匹配。候选不接受模型自报来源。

来源的 Actor 固定为原 generation 的 Actor。同一拥有者以另一有效 Actor 读取时仍使用原来源、归档键和候选，不产生一份新的素材；实际调用者每次独立授权。跨 tenant、space、principal 或 project 拒绝。

## 新候选与读取

`ProjectMediaResultPublisher.publish` 先取得独立 `projectMediaResult:publish` 和 read 资格，再由 native 子存储检查发布资格。没有旧候选时，归档项目在任何供应商图片 GET 前拒绝；DNS 后及保存前再次核原来源、项目状态和活动权限。DNS 使用既有生产出口规则并固定解析结果，198.18 等私网/保留地址不获准，重定向也不跟随。

首次读取只 GET 原位置，不 POST、不新建 Run、不重新准备或上传素材。响应要求200、`image/png`、identity编码及一致的可选 Content-Length。已有 PNG 检查器校验签名、块顺序/CRC、zlib和实际扫描线，限制16MiB、4096×4096、8位RGB/RGBA、非交错图片。随后保存 SHA-256、实际字节长度和尺寸。

`readCandidate` 只读 SQL 候选与冻结字节，每次重新授权和核来源。已有候选在项目归档后仍可获准读取或原键重放。输入 head、当前采用指针或供应商文件后来变化，不替换已接受历史和冻结字节；新候选须使用另一个实际接受的执行。

## 不可变归档与原事务

`FilesystemProjectMediaResultArchive` 使用独立文件命名空间和原 artifacts 包的 AES-256-GCM、原子独占发布与 fsync 机制。归档/请求/文件种类/keyId 参与认证，键由原 Actor、原 project/Run/resultIndex 和 archiveId 推导。构造器不持有外部凭据，关闭时清空自己的密钥副本。

先持久记录原观察 intent，再发布字节。两个实际实例看到相同来源和字节时保留第一份持久时间；不同字节或来源冲突，不能覆盖。文件或 intent 丢失、损坏、错误密钥、路径被替换等情况失败，不回到供应商重新 GET。只有显式提供确切原冻结记录及原字节的底层恢复才可补回同一 intent；Publisher 不执行这种修复。

`crewon.project-media-result-candidate.v1` 固定唯一候选和完整冻结摘要。新增 `project_media_result_candidates` 及独立 schema marker 在实际父存储上显式迁移，构造不 DDL。每个 tenant/Run/resultIndex 唯一，原 operation 是外键，候选和 marker 禁止更新/删除。每条 SQL 前后及提交前检查原 owner 和同步活动资格；最后 INSERT 后撤权会回滚候选。SQLite 事务中不等待异步授权，PostgreSQL 提交前再异步授权。

文件和 SQL 不是一个事务。文件已持久、SQL 未提交时留下原 intent/字节，下一次沿同一来源复用归档并保存候选，不再次 GET。SQL 已保存但文件丢失时保留原候选并报错，不替换或冒充可用。

## 兼容与后续接线

新子存储、权限和归档协议是可选宿主组件，不改变原 asset/reference、概念图、文字计划、Tool IO 或 external operation 形状。原 Short21 仍返回有界图片位置摘要，完整字节只在宿主持有，不能注入 Agent 上下文。积分继续沿原明确不计费路径，未定义新价格。

下一步将候选保存和读取接到 Main、原 Agent 与手动工作台共同命令，补实际 Worker 回执/恢复，然后以独立 CAS 采用操作建立角色参考或分镜素材依赖。D18 当前是有采用剧本来源的双人物画面探索，不能把一个生成画面当成完整镜头表。结构化分镜、视频、配音/声音、剪辑和有限跨阶段计划仍按 [阶段契约](./short-drama-stage-execution-contract.md)实施。

集成检查使用实际冻结Short21安装/Node handler、原项目/Run/供应商占用、真实SQLite/PostgreSQL和加密文件；PDP/部署审查、DNS/供应商响应及私有工具回执签发是具名夹具。这个范围不宣称真实远端生成、完整RuntimeWorker、Main或正式桌面联合验收。
