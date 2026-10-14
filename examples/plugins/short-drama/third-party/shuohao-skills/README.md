# shuohao-skills 文档与阶段适配

来源：https://github.com/eternityspring/shuohao-skills
固定版本：`dd1adef5c8189b489f6b901e8ab8d7c394c81a3e`，Apache-2.0。来源于 2026-10-14 核对的上游 main；运行时不追踪远端变化。

本目录保留六个阶段的原始 `SKILL.md` 与其 Markdown 参考资料，共 35 份文件。文件未改写；`provenance.json` 记录源版本、路径、大小与 SHA-256。保留原始 LICENSE 和 NOTICE。没有复制脚本、示例产物、报告图片或安装器。

`src/creation-skills.ts`、`src/project-foundation-creation-skill.ts` 通过现有项目、资产、媒体输入和 Foundation 上下文工具加载当前阶段的审阅片段。片段逐字来源于对应 `SKILL.md`，附精确源文件摘要和行号；CrewON 的适配说明另列。项目/资产指导小于 4 KiB，Foundation 指导小于 3 KiB。未同时注入六个 Skill、全文或无限历史；切换阶段不会调用生成服务。

上游 frontmatter 中的 `allowed-tools`、命令行示例和跨阶段默认值不构成 CrewON 的授权。当前 host scope、用户确认的参数、已保存来源版本与现有结构化工具协议始终优先。没有打包或执行上游 CLI、HTML 报告器和完整质量门；`qualityChecks: "not-run"` 明确反映这一点，不能声称与上游完整 JSON 格式或检查结果兼容。原始文档可供审阅，不表示每一项步骤已接通。

`src/stage-skill-resource-reader.ts` 备好有界只读适配器：按真实当前阶段选择允许文件，以 Unicode 字符分页、校验固定文件摘要，不读脚本、其他阶段、URL 或任意路径。它尚未注册为模型工具；接入必须通过现有宿主的项目作用域协议，不能将客户端传入阶段当权限。

当前上游 `novel-storyboard/SKILL.md` 明确只产分镜描述/提示词，不出图；其 README 中旧的出图说明不能替代实际文档。`character-refs` 原脚本包含 shell/codex 与外部 API 调用，未纳入执行能力。图片生成继续由同一插件已授权的 Krea2/ComfyUI 适配器执行；未接通的视频、配音和导出不因指导文字而变为可用。
