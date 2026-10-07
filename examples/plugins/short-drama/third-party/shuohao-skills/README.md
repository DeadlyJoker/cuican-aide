# shuohao-skills 阶段适配

来源：https://github.com/eternityspring/shuohao-skills
固定版本：`ef4ac0c313c7eeb1f918db5f0f0eb319745900bc`，Apache-2.0。

`src/creation-skills.ts` 根据 novel-outline、novel-script、novel-characters、novel-art、character-refs、novel-storyboard 的创作方法重新整理为 CrewON 阶段指导。通过现有项目/资产/媒体输入上下文工具按当前阶段返回，单次指导小于 4 KiB；不将所有技能或历史常驻注入。

本适配保留 CrewON 的结构化项目工具、候选/采用、来源版本与授权边界。没有打包或执行上游 CLI、HTML 报告器和完整质量门，不声称与上游完整 JSON 格式兼容。未接入的分镜视频、配音和导出不能被指导文字变成可用能力。图片生成继续由同一插件已授权的 Krea2/ComfyUI 适配器执行。
