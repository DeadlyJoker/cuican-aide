# 分集剧本数据与 Skill 校验

## 已实现范围

新增独立内容格式 `crewon.project-script-document.v2`，保留原 episodeId、场次 occurrence ID、场景实体引用和动作/对白 beatId。动作和对白按发生顺序共用 flow；对白逐句保留角色、正文和表演提示，开场钩子引用稳定 beatId。旧 `crewon.project-text-revision.v1` 及其剧本解析器不变，没有把旧版分开的 action/dialogue 伪造为有序节拍。

使用用户指定 [shuohao-skills 的 novel-script](https://github.com/eternityspring/shuohao-skills/tree/ef4ac0c313c7eeb1f918db5f0f0eb319745900bc/skills/novel-script) 固定提交，保留实际纯函数与 Apache-2.0 归属。确定性估时、十项质量门及原六集样例已接入 Domain。完整文档可包含 120 集，在 240 KiB 内容预算内；seed 默认按最多三集生成一批，数据格式没有人为限定全剧只能三集或每集最多 32 场。

seed 从原大纲搬运集号、目标秒数、钩子、悬念和爽点 ID，不生成故事。校验另外检查实际分集身份/集号、目标时长和确切爽点 ID，避免同类型的两个爽点漏认领。缺少大纲或美术引用时，相关门显示 skipped，`allGatesPassed` 为 false。估时是预算估算，不是实际配音时长；动作是否易于生成、人物口吻和钩子的语义落实不在十项确定性检查覆盖内。

## 检查

19 项新增行为检查通过，包括固定样例十门通过、原统计字节/数值一致、十门逐项击穿、光照/道具引用、同类型爽点漏认领、稳定身份、缺失上游跳过、超过旧场数限制、getter/原型/循环/字节预算/歧义字段拒绝、原不透明素材 ID、跨集钩子拒绝、引用上下文拒绝访问器及空时长参数、旧格式保持严格。实际模型、TTS、分镜和供应商生成均未执行。

## 下一步

这个模块只提供内容解析、seed、统计和质量报告，尚未连接原持久化 revision/receipt、Agent Run 工具、计划检查点或插件编辑器。后续接入需要独立协议和原来源/事务验证，不能把纯数据文档当作保存或执行权限。本轮桌面 0.1.57 不包含这些新增模块。
